import { nanoid } from 'nanoid';
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
} from '../types.js';
import { DayaClient } from '../daya/client.js';
import { LocalMemory } from '../dayamemory/local.js';

export interface AgentDeps {
  provider: Provider;
  tools: Tool[];
  permissions: PermissionChecker;
  cwd: string;
  system?: string;
  maxSteps?: number;
  maxTokens?: number;
  daya?: AgentDayaConfig;
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
    | 'done'
    | 'error';
  data: unknown;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  history?: Message[];
}

const DEFAULT_SYSTEM = `You are DAYA Code, a terminal code agent.
You help users modify codebases by reading, editing and running commands.
Use the available tools to inspect the repo before making changes.
Be concise, explain your plan before mutating files, and prefer minimal diffs.`;

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_MAX_TOKENS = 4096;
const CONTEXT_COMPACTION_THRESHOLD = 0.9;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

export class Agent {
  private readonly deps: AgentDeps;

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  toolDefinitions(): ToolDefinition[] {
    return this.deps.tools.map((t) => t.definition);
  }

  async run(prompt: string, options: AgentRunOptions = {}): Promise<Message[]> {
    const messages: Message[] = options.history ? [...options.history] : [];
    const baseSystem = this.deps.system ?? DEFAULT_SYSTEM;
    const system = await this.composeSystem(baseSystem, prompt);
    const maxSteps = this.deps.maxSteps ?? DEFAULT_MAX_STEPS;
    const maxTokens = this.deps.maxTokens ?? DEFAULT_MAX_TOKENS;
    const signal = options.signal ?? new AbortController().signal;

    messages.push({
      id: nanoid(),
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    });
    options.onEvent?.({ type: 'user_message', data: messages[messages.length - 1] });

    let steps = 0;
    let consecutiveErrors = 0;

    while (steps < maxSteps) {
      if (signal.aborted) throw new Error('aborted');
      steps += 1;

      // Auto-compact context if approaching limit
      await this.compactIfNeeded(messages, maxTokens, system, options.onEvent);

      // Stream provider with retry
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
          break; // success
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

      if (toolCalls.length === 0) {
        options.onEvent?.({ type: 'done', data: { reason: 'end_turn' as StopReason, messages } });
        return messages;
      }

      // Parallel tool execution
      await this.executeToolCallsParallel(toolCalls, {
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
    }

    options.onEvent?.({ type: 'done', data: { reason: 'tool_use' as StopReason, messages } });
    return messages;
  }

  private async composeSystem(base: string, prompt: string): Promise<string> {
    const daya = this.deps.daya;
    if (!daya || daya.autoRecall === false) return base;
    if (!daya.memory) return base;
    const ns = daya.namespace ?? this.deps.cwd.replace(/\\/g, '/').toLowerCase();
    const topK = daya.autoRecallTopK ?? 5;
    let hits: { key: string; value: string; score: number }[] = [];
    try {
      hits = await daya.memory.query(ns, prompt, topK);
    } catch {
      return base;
    }
    if (hits.length === 0) return base;
    const lines = hits.map((h) => `- [${h.key}] ${h.value}`);
    return `${base}\n\n## Relevant memories for this project\nThe following facts were remembered from prior sessions. Use them if relevant, ignore them if not.\n${lines.join('\n')}`;
  }

  private async compactIfNeeded(
    messages: Message[],
    maxTokens: number,
    system: string,
    onEvent?: (e: AgentEvent) => void,
  ): Promise<void> {
    const estimated = this.estimateTokens(messages, system);
    const threshold = Math.floor(maxTokens * CONTEXT_COMPACTION_THRESHOLD);
    if (estimated < threshold) return;

    // Keep the last 4 messages, summarize the rest
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
  ): Promise<void> {
    // Identify mutating tools that must run sequentially
    const mutatingTools = new Set(['write_file', 'edit_file', 'bash']);
    const mutating: ToolCall[] = [];
    const readonly: ToolCall[] = [];

    for (const call of calls) {
      if (mutatingTools.has(call.name)) {
        mutating.push(call);
      } else {
        readonly.push(call);
      }
    }

    // Run read-only tools in parallel
    if (readonly.length > 0) {
      const results = await Promise.allSettled(
        readonly.map((call) => this.executeSingleTool(call, ctx)),
      );
      for (let i = 0; i < readonly.length; i++) {
        const call = readonly[i]!;
        const result = results[i]!;
        if (result.status === 'fulfilled') {
          ctx.onResult(call.id, result.value);
        } else {
          const errResult: ToolResult = {
            output: result.reason instanceof Error ? result.reason.message : String(result.reason),
            isError: true,
          };
          ctx.onResult(call.id, errResult);
        }
      }
    }

    // Run mutating tools sequentially
    for (const call of mutating) {
      if (ctx.signal.aborted) break;
      const result = await this.executeSingleTool(call, ctx);
      ctx.onResult(call.id, result);
    }
  }

  private async executeSingleTool(
    call: ToolCall,
    ctx: { signal: AbortSignal; onEvent?: (e: AgentEvent) => void },
  ): Promise<ToolResult> {
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
