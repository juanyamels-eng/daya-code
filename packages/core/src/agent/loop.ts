import { nanoid } from 'nanoid';
import { readFile, stat, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import type {
  Message,
  Provider,
  ProviderEvent,
  PermissionChecker,
  StopReason,
  Tool,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
  AgentMode,
  ContextInfo,
  EditReviewChange,
} from '../types.js';
import { DayaClient } from '../daya/client.js';
import { LocalMemory } from '../dayamemory/local.js';
import { CheckpointManager, FileWatcher, getDiagnostics, type FileChange, type LspDiagnostic } from '../utils.js';

export interface AgentDeps {
  provider: Provider;
  tools: Tool[];
  permissions: PermissionChecker;
  cwd: string;
  system?: string;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  mode?: AgentMode;
  daya?: AgentDayaConfig;
  conventions?: string;
  lintCmd?: string;
  testCmd?: string;
  autoCommit?: boolean;
  architectModel?: string;
  memoryFile?: string;
  checkpointDir?: string;
  watchFiles?: boolean;
  maxSelfCorrections?: number;
  requestApproval?: (change: EditReviewChange) => Promise<boolean>;
}

export interface AgentDayaConfig {
  client?: DayaClient | null;
  memory?: LocalMemory | null;
  namespace?: string;
  autoRecall?: boolean;
  autoRecallTopK?: number;
}

export interface AgentEvent {
  type:
    | 'user_message'
    | 'assistant_text_delta'
    | 'assistant_message'
    | 'tool_started'
    | 'tool_output'
    | 'tool_finished'
    | 'tool_denied'
    | 'compacted'
    | 'context'
    | 'mode_changed'
    | 'checkpoint_created'
    | 'diagnostics'
    | 'file_changed'
    | 'memory_saved'
    | 'self_correct'
    | 'done'
    | 'error';
  data: unknown;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  history?: Message[];
  mode?: AgentMode;
  mentionFiles?: string[];
}

const DEFAULT_SYSTEM = `You are DAYA Code, a terminal code agent.
You help users modify codebases by reading, editing and running commands.
Use the available tools to inspect the repo before making changes.
Be concise, explain your plan before mutating files, and prefer minimal diffs.`;

const PLAN_SUFFIX = `\n\n## Current mode: PLAN
You are in **plan mode**. You can ONLY read and analyze.
You may use: read_file, glob, grep.
You MUST NOT use: write_file, edit_file, bash.
When the user asks you to make changes, explain what you would do step by step.
The user will switch to build mode when ready.`;

const BUILD_SUFFIX = `\n\n## Current mode: BUILD
You are in **build mode**. You can read, edit, and run commands.
Execute the user's requests. After editing files, summarize what you changed.
When a request involves multiple distinct steps, begin by listing the steps you plan to take as a checklist, e.g.:
- [ ] Step one
- [ ] Step two
As you complete each step, rewrite that line to \`- [x] Step one\` so the user can follow progress. If the task is a single action, you may skip the checklist.`;

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_MAX_TOKENS = 4096;
const CONTEXT_COMPACTION_THRESHOLD = 0.9;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_MENTION_BYTES = 2 * 1024 * 1024;

const PLAN_ONLY_TOOLS = new Set(['read_file', 'glob', 'grep']);
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'daya_generate_image']);

export class Agent {
  private readonly deps: AgentDeps;
  private currentMode: AgentMode;
  private filesReferenced: Set<string> = new Set();
  private conventions: string | undefined;
  private checkpoints = new CheckpointManager();
  private watcher: FileWatcher | null = null;
  private trackedFiles: Set<string> = new Set();
  private contextMessages: Message[] = [];

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.currentMode = deps.mode ?? 'build';
    this.conventions = deps.conventions;
  }

  getMode(): AgentMode {
    return this.currentMode;
  }

  setMode(mode: AgentMode): void {
    this.currentMode = mode;
  }

  // --- Checkpoints ---
  getCheckpoints() {
    return this.checkpoints.list();
  }

  async saveCheckpoint(label: string, messages: Message[]): Promise<string> {
    this.trackedFiles = new Set([...this.trackedFiles, ...this.filesReferenced]);
    const cp = await this.checkpoints.save(label, messages, this.currentMode, this.deps.cwd, this.trackedFiles);
    return cp.id;
  }

  async restoreCheckpoint(id: string): Promise<Message[] | null> {
    const restored = this.checkpoints.restore(id);
    if (!restored) return null;
    await this.checkpoints.restoreFiles(id);
    this.currentMode = restored.mode as AgentMode;
    return restored.messages;
  }

  // --- File watcher ---
  startWatcher(onChange?: (changes: FileChange[]) => void): void {
    if (!this.deps.watchFiles) return;
    this.watcher = new FileWatcher(this.deps.cwd);
    this.watcher.trackMany(new Set([...this.filesReferenced, ...this.trackedFiles]));
    this.watcher.start((changes) => {
      if (onChange) onChange(changes);
    });
  }

  stopWatcher(): void {
    this.watcher?.stop();
    this.watcher = null;
  }

  // --- LSP diagnostics ---
  async getDiagnosticsForFile(filePath: string): Promise<LspDiagnostic[]> {
    try {
      return await getDiagnostics(filePath);
    } catch {
      return [];
    }
  }

  // --- Memory file persistence (auto-update DAYA.md) ---
  async saveMemory(key: string, value: string): Promise<boolean> {
    const cwd = this.deps.cwd;
    try {
      // Honor a configured memory file (e.g. a shared project file) and fall
      // back to the conventional DAYA.md at the project root.
      const file = this.deps.memoryFile ?? resolve(cwd, 'DAYA.md');
      if (!existsSync(file)) {
        await writeFile(file, `# Project Memory\n\n- ${key}: ${value}\n`, 'utf8');
        return true;
      }
      const existing = await readFile(file, 'utf8');
      const kvLine = `${key}: ${value}`;
      const entryRegex = new RegExp(`^\\s*-\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:.*$`, 'gm');
      let updated: string;
      if (entryRegex.test(existing)) {
        updated = existing.replace(entryRegex, `- ${kvLine}`);
      } else {
        updated = existing.endsWith('\n')
          ? `${existing}- ${kvLine}\n`
          : `${existing}\n- ${kvLine}\n`;
      }
      await writeFile(file, updated, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  async extractMemoriesFromConversation(messages: Message[]): Promise<{ key: string; value: string }[]> {
    const memories: { key: string; value: string }[] = [];
    const userMsgs = messages.filter((m) => m.role === 'user');
    const assistantMsgs = messages.filter((m) => m.role === 'assistant');

    for (const msg of assistantMsgs) {
      // Commands discovered
      const testCmdMatch = msg.content.match(/run (?:the )?(?:tests|test suite)(?: with| using|:)?[^:\n]{0,40}(npm (?:test|run [a-z-]+)|pnpm (?:test|run [a-z-]+)|yarn (?:test|run [a-z-]+))/i);
      if (testCmdMatch) {
        memories.push({ key: 'test command', value: testCmdMatch[1]! });
      }
      const lintCmdMatch = msg.content.match(/run (?:the )?(?:linter|lint)(?: with| using|:)?[^:\n]{0,40}(npm run lint|pnpm run lint|yarn lint|eslint \.)/i);
      if (lintCmdMatch) {
        memories.push({ key: 'lint command', value: lintCmdMatch[1]! });
      }
    }

    // Framework/package manager
    for (const msg of userMsgs) {
      const pmMatch = msg.content.match(/using (npm|pnpm|yarn|bun)\b/i);
      if (pmMatch && !memories.some((m) => m.key === 'package manager')) {
        memories.push({ key: 'package manager', value: `use ${pmMatch[1]!.toLowerCase()}` });
      }
    }

    return memories;
  }

  async persistMemories(messages: Message[]): Promise<void> {
    const memories = await this.extractMemoriesFromConversation(messages);
    for (const mem of memories) {
      await this.saveMemory(mem.key, mem.value);
    }
    if (memories.length > 0) {
      // Also persist to DAYA memory store if available
      const daya = this.deps.daya;
      if (daya?.memory) {
        const ns = daya.namespace ?? this.deps.cwd.replace(/\\/g, '/').toLowerCase();
        for (const mem of memories) {
          try {
            await daya.memory.upsert({
              namespace: ns,
              key: mem.key,
              value: mem.value,
              metadata: null,
              expiresAt: null,
            });
          } catch {
            // ignore
          }
        }
      }
    }
  }

  toolDefinitions(): ToolDefinition[] {
    const all = this.deps.tools.map((t) => t.definition);
    if (this.currentMode === 'plan') {
      return all.filter((d) => PLAN_ONLY_TOOLS.has(d.name));
    }
    return all;
  }

  getContextInfo(): ContextInfo {
    const system = this.deps.system ?? DEFAULT_SYSTEM;
    return {
      estimatedTokens: this.estimateTokens(this.contextMessages, system),
      maxTokens: this.deps.maxTokens ?? DEFAULT_MAX_TOKENS,
      messageCount: this.contextMessages.length,
      filesReferenced: [...this.filesReferenced],
      mode: this.currentMode,
    };
  }

  async run(prompt: string, options: AgentRunOptions = {}): Promise<Message[]> {
    const messages: Message[] = options.history ? [...options.history] : [];
    this.contextMessages = messages;

    if (options.mode) {
      this.currentMode = options.mode;
    }

    const baseSystem = this.deps.system ?? DEFAULT_SYSTEM;
    const system = await this.composeSystem(baseSystem, prompt);
    const maxSteps = this.deps.maxSteps ?? DEFAULT_MAX_STEPS;
    const maxTokens = this.deps.maxTokens ?? DEFAULT_MAX_TOKENS;
    const signal = options.signal ?? new AbortController().signal;

    // Resolve @file mentions
    const { cleanPrompt, fileContents } = await this.resolveMentions(prompt);
    if (fileContents.length > 0) {
      for (const fc of fileContents) {
        this.filesReferenced.add(fc.path);
      }
    }

    messages.push({
      id: nanoid(),
      role: 'user',
      content: cleanPrompt,
      timestamp: Date.now(),
    });
    options.onEvent?.({ type: 'user_message', data: messages[messages.length - 1] });

    let steps = 0;
    let consecutiveErrors = 0;
    const maxSelfCorrections = this.deps.maxSelfCorrections ?? 2;
    let selfCorrectionsUsed = 0;

    while (steps < maxSteps) {
      if (signal.aborted) throw new Error('aborted');
      steps += 1;

      await this.compactIfNeeded(messages, maxTokens, system, options.onEvent);

      let textAccum = '';
      const toolCalls: ToolCall[] = [];
      let streamError: Error | null = null;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const events = this.deps.provider.stream({
            system,
            messages,
            tools: this.toolDefinitions(),
            maxTokens,
            temperature: this.deps.temperature,
            signal,
          });

          for await (const ev of events) {
            if (signal.aborted) break;
            await this.handleProviderEvent(ev, {
              onText: (delta) => {
                textAccum += delta;
                options.onEvent?.({ type: 'assistant_text_delta', data: { delta } });
              },
              onToolUse: (toolCall) => {
                toolCalls.push(toolCall);
              },
              onMessage: (msg) => {
                options.onEvent?.({ type: 'assistant_message', data: msg });
              },
            });
          }

          streamError = null;
          break;
        } catch (err) {
          if (signal.aborted) throw new Error('aborted');
          const isRetryable = this.isRetryableError(err);
          if (!isRetryable || attempt === MAX_RETRIES - 1) {
            streamError = err instanceof Error ? err : new Error(String(err));
            break;
          }
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
          await sleep(delay);
        }
      }

      if (signal.aborted) throw new Error('aborted');
      if (streamError) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 3) {
          options.onEvent?.({ type: 'error', data: streamError.message });
          throw streamError;
        }
        options.onEvent?.({ type: 'error', data: `${streamError.message} (retry ${consecutiveErrors}/3)` });
        continue;
      }

      consecutiveErrors = 0;

      const assistantMsg: Message = {
        id: nanoid(),
        role: 'assistant',
        content: textAccum,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        timestamp: Date.now(),
      };
      messages.push(assistantMsg);
      this.contextMessages = messages;

      if (toolCalls.length === 0) {
        options.onEvent?.({ type: 'done', data: { reason: 'end_turn' as StopReason, messages } });
        return messages;
      }

      const toolResults = await this.executeToolCallsParallel(toolCalls, {
        signal,
        onEvent: options.onEvent,
        onResult: (id, result) => {
          messages.push({
            id: nanoid(),
            role: 'tool',
            content: result.output,
            toolCallId: id,
            timestamp: Date.now(),
          });
        },
      });
      this.contextMessages = messages;

      // Self-correction: if tools reported errors and we still have budget,
      // feed the failures back to the model and let it fix its approach.
      const failedTools = toolResults
        .map((r, i) => (r.isError ? toolCalls[i]!.name : null))
        .filter((n): n is string => n !== null);
      if (failedTools.length > 0 && selfCorrectionsUsed < maxSelfCorrections && this.currentMode === 'build') {
        selfCorrectionsUsed += 1;
        const unique = [...new Set(failedTools)];
        const feedback: Message = {
          id: nanoid(),
          role: 'system',
          content:
            `[Agent self-correction ${selfCorrectionsUsed}/${maxSelfCorrections}] The following tool call(s) failed: ${unique.join(', ')}. ` +
            'Review the error output above, adjust your approach (re-read the file, use a different command, fix the arguments), and try again. ' +
            'Do not repeat the exact same failing call.',
          timestamp: Date.now(),
        };
        messages.push(feedback);
        options.onEvent?.({ type: 'self_correct', data: { attempt: selfCorrectionsUsed, failed: unique } });
        continue;
      }

      // Run lint + tests after a step that actually mutated the repo
      if (toolCalls.some((tc) => MUTATING_TOOLS.has(tc.name))) {
        if (this.deps.lintCmd) {
          await this.runPostMutationHook(this.deps.lintCmd, 'lint', signal, options.onEvent);
        }
        if (this.deps.testCmd) {
          await this.runPostMutationHook(this.deps.testCmd, 'test', signal, options.onEvent);
        }
      }
    }

    options.onEvent?.({ type: 'done', data: { reason: 'tool_use' as StopReason, messages } });
    return messages;
  }

  // --- @file mentions ---
  private async resolveMentions(
    prompt: string,
  ): Promise<{ cleanPrompt: string; fileContents: { path: string; content: string }[] }> {
    const mentionRegex = /@([^\s@][^\s@]*)/g;
    const fileContents: { path: string; content: string }[] = [];
    let cleanPrompt = prompt;

    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(prompt)) !== null) {
      const raw = match[1]!;
      const filePath = isAbsolute(raw) ? raw : resolve(this.deps.cwd, raw);
      try {
        const s = await stat(filePath);
        if (s.isFile() && s.size <= MAX_MENTION_BYTES) {
          const content = await readFile(filePath, 'utf8');
          fileContents.push({ path: filePath, content });
          this.filesReferenced.add(filePath);
        }
      } catch {
        // file not found, ignore
      }
    }

    if (fileContents.length > 0) {
      const attachments = fileContents
        .map((f) => `--- ${f.path} ---\n${f.content}`)
        .join('\n\n');
      cleanPrompt = `${prompt}\n\n## Attached files\n${attachments}`;
    }

    return { cleanPrompt, fileContents };
  }

  // --- Architect mode (two-pass) ---
  async runArchitect(
    prompt: string,
    options: AgentRunOptions = {},
  ): Promise<{ plan: Message[]; execution: Message[] }> {
    // Phase 1: Plan with current (strong) model
    this.currentMode = 'plan';
    options.onEvent?.({ type: 'context', data: { phase: 'planning', mode: 'plan' } });

    const planMessages = await this.run(prompt, options);

    // Phase 2: Execute with architectModel if configured
    if (this.deps.architectModel) {
      options.onEvent?.({ type: 'context', data: { phase: 'executing', mode: 'build' } });
      this.currentMode = 'build';

      const planText = planMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content)
        .join('\n\n');

      const execPrompt = `Execute this plan:\n\n${planText}`;
      const execMessages = await this.run(execPrompt, { ...options, history: [] });
      return { plan: planMessages, execution: execMessages };
    }

    return { plan: planMessages, execution: [] };
  }

  // --- System prompt composition ---
  private async composeSystem(base: string, prompt: string): Promise<string> {
    let system = base;

    // Add conventions
    if (this.conventions) {
      system += `\n\n## Project conventions\n${this.conventions}`;
    }

    // Add memories
    const daya = this.deps.daya;
    if (daya && daya.autoRecall !== false && daya.memory) {
      const ns = daya.namespace ?? this.deps.cwd.replace(/\\/g, '/').toLowerCase();
      const topK = daya.autoRecallTopK ?? 5;
      try {
        const hits = await daya.memory.query(ns, prompt, topK);
        if (hits.length > 0) {
          const lines = hits.map((h) => `- [${h.key}] ${h.value}`);
          system += `\n\n## Relevant memories\nThe following facts were remembered from prior sessions. Use them if relevant, ignore them if not.\n${lines.join('\n')}`;
        }
      } catch {
        // ignore
      }
    }

    // Add mode suffix
    system += this.currentMode === 'plan' ? PLAN_SUFFIX : BUILD_SUFFIX;

    return system;
  }

  // --- Post-mutation hooks ---
  private async runPostMutationHook(
    cmd: string,
    label: string,
    signal: AbortSignal,
    onEvent?: (e: AgentEvent) => void,
  ): Promise<void> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      // Use cmd.exe on Windows so hooks work on machines without bash.
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd' : 'bash';
      const args = isWin ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
      const result = await execFileAsync(shell, args, {
        cwd: this.deps.cwd,
        timeout: 30000,
        signal,
      });
      if (result.stderr) {
        onEvent?.({ type: 'tool_output', data: { name: label, output: result.stderr } });
      }
    } catch {
      // lint/test failure is non-fatal
    }
  }

  // --- Auto-commit ---
  async autoCommit(
    message: string,
    cwd: string,
    signal: AbortSignal,
    opts: { force?: boolean; paths?: string[] } = {},
  ): Promise<boolean> {
    // Without `force`, commits only happen when auto-commit is enabled. The
    // forced mode is used by the TUI's explicit `/commit`, which stages
    // nothing new (only already-staged changes are committed), so unrelated
    // user work is never swept in.
    if (!opts.force && !this.deps.autoCommit) return false;
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const commit = () =>
        execFileAsync('git', ['commit', '-m', message, '--allow-empty'], { cwd, signal });
      if (opts.force) {
        await commit();
      } else if (opts.paths && opts.paths.length > 0) {
        await execFileAsync('git', ['add', '--', ...opts.paths], { cwd, signal });
        await commit();
      } else {
        await execFileAsync('git', ['add', '-A'], { cwd, signal });
        await commit();
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Undo the DAYA agent's last commit without destroying user work.
   * Only touches the most recent commit when its subject starts with `daya:`
   * (DAYA's own auto-commits) and uses `git reset --soft HEAD~1`, so the
   * changes stay in the index/working tree instead of being wiped.
   */
  async revertLastCommit(cwd: string, signal: AbortSignal): Promise<string> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const result = await execFileAsync('git', ['log', '-1', '--format=%H%n%s'], { cwd, signal });
    const [hash, subject] = result.stdout.trim().split('\n');
    if (!subject || !subject.startsWith('daya:')) {
      throw new Error(
        `refusing to undo last commit "${subject ?? '(none)'}" — only DAYA commits (subject prefix "daya:") are reverted, so your own work is never wiped`,
      );
    }
    await execFileAsync('git', ['reset', '--soft', 'HEAD~1'], { cwd, signal });
    return hash ?? 'unknown';
  }

  // --- Compaction ---
  private async compactIfNeeded(
    messages: Message[],
    maxTokens: number,
    system: string,
    onEvent?: (e: AgentEvent) => void,
  ): Promise<void> {
    const estimated = this.estimateTokens(messages, system);
    const threshold = Math.floor(maxTokens * CONTEXT_COMPACTION_THRESHOLD);
    if (estimated < threshold) return;
    this.doCompact(messages, onEvent);
  }

  compactManual(
    messages: Message[],
    onEvent?: (e: AgentEvent) => void,
  ): void {
    this.doCompact(messages, onEvent);
  }

  private doCompact(messages: Message[], onEvent?: (e: AgentEvent) => void): void {
    if (messages.length <= 6) return;

    const keepRecent = 4;
    const toCompact = messages.slice(0, messages.length - keepRecent);
    const kept = messages.slice(messages.length - keepRecent);

    const summary = toCompact
      .filter((m) => m.role === 'assistant' || m.role === 'user')
      .map((m) => {
        const prefix = m.role === 'user' ? 'User' : 'Assistant';
        const content = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
        return `${prefix}: ${content}`;
      })
      .join('\n');

    const compactMsg: Message = {
      id: nanoid(),
      role: 'system',
      content: `[Context compacted — earlier conversation summarized]\n${summary}`,
      timestamp: Date.now(),
    };

    messages.length = 0;
    messages.push(compactMsg, ...kept);

    onEvent?.({ type: 'compacted', data: { removed: toCompact.length, kept: kept.length } });
  }

  private estimateTokens(messages: Message[], system: string): number {
    let total = system.length / 4;
    for (const m of messages) {
      total += m.content.length / 4;
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          total += JSON.stringify(tc.input).length / 4;
        }
      }
    }
    return Math.ceil(total);
  }

  private isRetryableError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('429') || msg.includes('rate') || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('timeout') || msg.includes('econnreset') || msg.includes('fetch failed');
  }

  private async handleProviderEvent(
    ev: ProviderEvent,
    handlers: {
      onText: (delta: string) => void;
      onToolUse: (tc: ToolCall) => void;
      onMessage: (m: Message) => void;
    },
  ): Promise<void> {
    switch (ev.type) {
      case 'text_delta':
        handlers.onText(ev.delta);
        break;
      case 'tool_use':
        handlers.onToolUse(ev.toolCall);
        break;
      case 'message_complete':
        handlers.onMessage(ev.message);
        break;
      case 'done':
        break;
    }
  }

  private async executeToolCallsParallel(
    calls: ToolCall[],
    ctx: { signal: AbortSignal; onEvent?: (e: AgentEvent) => void; onResult: (id: string, r: ToolResult) => void },
  ): Promise<ToolResult[]> {
    const mutating: ToolCall[] = [];
    const readonly: ToolCall[] = [];
    const results = new Map<string, ToolResult>();

    for (const call of calls) {
      if (MUTATING_TOOLS.has(call.name)) {
        mutating.push(call);
      } else {
        readonly.push(call);
      }
    }

    if (readonly.length > 0) {
      const settled = await Promise.allSettled(
        readonly.map((call) => this.executeSingleTool(call, ctx)),
      );
      for (let i = 0; i < readonly.length; i++) {
        const call = readonly[i]!;
        const result = settled[i]!;
        if (result.status === 'fulfilled') {
          results.set(call.id, result.value);
          ctx.onResult(call.id, result.value);
        } else {
          const errResult: ToolResult = {
            output: result.reason instanceof Error ? result.reason.message : String(result.reason),
            isError: true,
          };
          results.set(call.id, errResult);
          ctx.onResult(call.id, errResult);
        }
      }
    }

    for (const call of mutating) {
      if (ctx.signal.aborted) break;
      const result = await this.executeSingleTool(call, ctx);
      results.set(call.id, result);
      ctx.onResult(call.id, result);

      // Track edited files for watcher/checkpoints
      if (call.name === 'write_file' || call.name === 'edit_file') {
        const filePath = (call.input as Record<string, string>)?.path;
        if (filePath) {
          const full = isAbsolute(filePath) ? filePath : resolve(this.deps.cwd, filePath);
          this.trackedFiles.add(full);
          this.filesReferenced.add(full);
          this.watcher?.track(full);

          // Run LSP diagnostics after edits
          const diagnostics = await this.getDiagnosticsForFile(full);
          if (diagnostics.length > 0) {
            ctx.onEvent?.({
              type: 'diagnostics',
              data: { file: full, diagnostics },
            });
          }
        }
      }

      // Auto-commit after file mutations — stage only the touched file(s)
      // instead of sweeping in unrelated user changes with `git add -A`.
      if (this.deps.autoCommit && (call.name === 'write_file' || call.name === 'edit_file')) {
        const path = (call.input as Record<string, string>)?.path ?? 'unknown file';
        const full = isAbsolute(path) ? path : resolve(this.deps.cwd, path);
        await this.autoCommit(`daya: update ${path}`, this.deps.cwd, ctx.signal, { paths: [full] });
      }
    }

    return calls.map((c) => results.get(c.id)!);
  }

  private async executeSingleTool(
    call: ToolCall,
    ctx: { signal: AbortSignal; onEvent?: (e: AgentEvent) => void },
  ): Promise<ToolResult> {
    // Block mutating tools in plan mode
    if (this.currentMode === 'plan' && MUTATING_TOOLS.has(call.name)) {
      const result: ToolResult = {
        output: `Tool "${call.name}" is not available in plan mode. Switch to build mode to make changes.`,
        isError: true,
      };
      ctx.onEvent?.({ type: 'tool_finished', data: { id: call.id, name: call.name, result } });
      return result;
    }

    const tool = this.deps.tools.find((t) => t.definition.name === call.name);
    if (!tool) {
      const result: ToolResult = { output: `Tool "${call.name}" not found.`, isError: true };
      ctx.onEvent?.({ type: 'tool_finished', data: { id: call.id, name: call.name, result } });
      return result;
    }

    ctx.onEvent?.({ type: 'tool_started', data: { id: call.id, name: call.name, input: call.input } });

    const toolCtx: ToolContext = {
      cwd: this.deps.cwd,
      signal: ctx.signal,
      permissions: this.deps.permissions,
      dayaClient: this.deps.daya?.client ?? null,
      memory: this.deps.daya?.memory ?? null,
      requestApproval: this.deps.requestApproval,
    };

    try {
      const result = await tool.execute(call.input, toolCtx);
      ctx.onEvent?.({ type: 'tool_finished', data: { id: call.id, name: call.name, result } });
      return result;
    } catch (err) {
      const result: ToolResult = {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
      ctx.onEvent?.({ type: 'tool_finished', data: { id: call.id, name: call.name, result } });
      return result;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadConventions(cwd: string): Promise<string | undefined> {
  const candidates = ['DAYA.md', 'AGENTS.md', 'CLAUDE.md', '.daya/conventions.md'];
  for (const name of candidates) {
    try {
      const content = await readFile(resolve(cwd, name), 'utf8');
      if (content.trim().length > 0) return content;
    } catch {
      // not found
    }
  }
  return undefined;
}
