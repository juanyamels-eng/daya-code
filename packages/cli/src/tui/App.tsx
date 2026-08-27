import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Agent,
  defaultTools,
  createProvider,
  SessionStore,
  loadConventions,
  buildFileTree,
  formatFileTree,
  estimateCost,
  formatCost,
  getGitDiff,
  generateCommitMessage,
  type AgentEvent,
  type AgentMode,
  type Message,
  type PermissionChecker,
  type Provider,
  type ProviderName,
  type PermissionAction,
  type PermissionDecision,
} from '@daya-code/core';
import { getTheme, THEME_NAMES, DEFAULT_THEME, type DayaTheme } from './themes.js';

export interface AppProps {
  initialPrompt: string;
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  cwd: string;
  sessionsDir?: string;
  lintCmd?: string;
  testCmd?: string;
  autoCommit?: boolean;
  architectModel?: string;
  theme?: string;
}

interface LogEntry {
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'diff' | 'diag';
  text: string;
  meta?: string;
  metaColor?: string;
}

interface PermissionPrompt {
  action: PermissionAction;
  resolve: (decision: PermissionDecision) => void;
}

interface ToolTiming {
  name: string;
  startedAt: number;
}

function makeProvider(p: AppProps): Provider {
  return createProvider({ name: p.provider, model: p.model, apiKey: p.apiKey, baseUrl: p.baseUrl });
}

function loadCustomPrompts(cwd: string): Record<string, string> {
  const prompts: Record<string, string> = {};
  const dirs = [join(cwd, '.daya', 'prompts'), join(cwd, '.daya')];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        if (!f.endsWith('.md') && !f.endsWith('.txt')) continue;
        const name = f.replace(/\.(md|txt)$/, '');
        const content = readFileSync(join(dir, f), 'utf8');
        prompts[name] = content;
      }
    } catch {
      // ignore
    }
  }
  return prompts;
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<AgentMode>('build');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [permissionPrompt, setPermissionPrompt] = useState<PermissionPrompt | null>(null);
  const [permissionInput, setPermissionInput] = useState('');
  const [themeName, setThemeName] = useState(props.theme ?? DEFAULT_THEME);
  const theme = getTheme(themeName);
  const agentRef = useRef<Agent>();
  const propsRef = useRef(props);
  propsRef.current = props;
  const messagesRef = useRef<Message[]>([]);
  const abortRef = useRef<AbortController>();
  const sessionRef = useRef<string | null>(null);
  const storeRef = useRef<SessionStore | null>(null);
  const modeRef = useRef<AgentMode>(mode);
  const customPromptsRef = useRef<Record<string, string>>({});
  const permissionHandlerRef = useRef<((action: PermissionAction) => Promise<PermissionDecision>) | undefined>();
  const toolTimingsRef = useRef<Record<string, ToolTiming>>({});
  const tokenStatsRef = useRef<{ inputTokens: number; outputTokens: number; queries: number; toolsRun: number }>({
    inputTokens: 0,
    outputTokens: 0,
    queries: 0,
    toolsRun: 0,
  });
  const perfStartRef = useRef<number>(Date.now());

  const handlePermission = useCallback(async (action: PermissionAction): Promise<PermissionDecision> => {
    return new Promise((resolve) => {
      setPermissionPrompt({ action, resolve });
      setPermissionInput('');
    });
  }, []);
  permissionHandlerRef.current = handlePermission;

  useEffect(() => {
    const store = props.sessionsDir ? new SessionStore(props.sessionsDir) : null;
    storeRef.current = store;
    customPromptsRef.current = loadCustomPrompts(props.cwd);

    (async () => {
      const conventions = await loadConventions(props.cwd);

      agentRef.current = new Agent({
        provider: makeProvider(props),
        tools: defaultTools(),
        permissions: new BridgePermissionChecker(permissionHandlerRef),
        cwd: props.cwd,
        conventions,
        lintCmd: props.lintCmd,
        testCmd: props.testCmd,
        autoCommit: props.autoCommit,
        architectModel: props.architectModel,
        memoryFile: join(props.cwd, 'DAYA.md'),
        watchFiles: true,
      });
      agentRef.current.startWatcher((changes) => {
        for (const change of changes) {
          setLogs((prev) => [...prev, { kind: 'system', text: `\u23f1 ${change.type} ${change.path} (external)` }]);
        }
      });

      if (store) {
        await store.init();
        const session = await store.create(props.cwd);
        sessionRef.current = session.meta.id;
      }

      const tree = await buildFileTree(props.cwd, 2).catch(() => null);
      const initial: LogEntry[] = [
        { kind: 'system', text: `v0.5.0 \u00b7 ${props.provider} \u00b7 ${props.model} \u00b7 ${props.cwd}` },
      ];
      if (tree && formatFileTree(tree).trim()) {
        initial.push({ kind: 'system', text: formatFileTree(tree), meta: 'project structure' });
      }
      initial.push({
        kind: 'system',
        text: 'Tab toggles plan/build \u00b7 /help lists commands \u00b7 @file attaches',
        meta: `theme: ${themeName}`,
      });
      setLogs(initial);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (key.ctrl && input === 'l') {
      setLogs([]);
      return;
    }
    if (key.shift && key.return) {
      setInput((prev) => (prev ? `${prev}\n` : ''));
      return;
    }
    if (key.tab && !busy && !permissionPrompt) {
      const next = modeRef.current === 'build' ? 'plan' : 'build';
      setMode(next);
      modeRef.current = next;
      agentRef.current?.setMode(next);
      setLogs((prev) => [...prev, { kind: 'system', text: `mode \u2192 ${next}` }]);
    }
  });

  const saveSession = async (): Promise<void> => {
    const store = storeRef.current;
    const sessionId = sessionRef.current;
    if (!store || !sessionId) return;
    try {
      const existing = await store.get(sessionId);
      if (existing) {
        existing.messages = messagesRef.current;
        await store.save(existing);
      }
    } catch {
      // silent
    }
  };

  const onPermissionSubmit = (text: string): void => {
    if (!permissionPrompt) return;
    const trimmed = text.trim().toLowerCase();
    setPermissionPrompt(null);
    setPermissionInput('');
    if (trimmed === 'y' || trimmed === 'yes' || trimmed === '') {
      permissionPrompt.resolve({ allowed: true, remember: 'once' });
    } else if (trimmed === 'a' || trimmed === 'always') {
      permissionPrompt.resolve({ allowed: true, remember: 'session' });
    } else {
      permissionPrompt.resolve({ allowed: false, reason: 'Denied by user' });
    }
  };

  const onSubmit = async (text: string): Promise<void> => {
    if (permissionPrompt) {
      onPermissionSubmit(text);
      return;
    }
    const trimmed = text.trim();
    setInput('');
    if (!trimmed) return;

    if (trimmed === '/quit' || trimmed === '/exit') {
      await saveSession();
      exit();
      return;
    }

    if (trimmed === '/clear' || trimmed === '/cls') {
      setLogs([]);
      messagesRef.current = [];
      await saveSession();
      return;
    }

    if (trimmed === '/help') {
      const customCmds = Object.keys(customPromptsRef.current);
      const customSection = customCmds.length > 0
        ? `\nfaint Custom prompts: ${customCmds.map((c) => `/${c}`).join(', ')}`
        : '';
      const lines = [
        `Commands`,
        `  /help           Show this help`,
        `  /mode plan      Switch to plan mode (read-only)`,
        `  /mode build     Switch to build mode`,
        `  /theme          Switch UI theme (${THEME_NAMES.join(', ')})`,
        `  /context        Token usage, cost, context info`,
        `  /compact        Compact history`,
        `  /commit         Generate message + commit`,
        `  /checkpoint     Save state`,
        `  /checkpoints    List checkpoints`,
        `  /rollback <id>  Restore checkpoint`,
        `  /stats          Session analytics`,
        `  /mem <k>: <v>   Save memory to DAYA.md`,
        `  /undo           Revert last commit`,
        `  /restore <id>   Resume session`,
        `  /search <q>     Search sessions`,
        `  /sessions       List sessions`,
        `  /export [file]  Export to markdown`,
        `  /model <id>     Switch model`,
        `  /clear          Clear screen`,
        `  /quit           Exit`,
        ``,
        `Shortcuts`,
        `  Tab             plan \u21c4 build`,
        `  Ctrl+L          clear screen`,
        `  Shift+Enter     newline in prompt`,
        `  @path/file      attach a file`,
        customSection,
      ];
      setLogs((prev) => [...prev, { kind: 'system', text: lines.join('\n'), meta: 'help' }]);
      return;
    }

    if (trimmed === '/mode plan' || trimmed === '/mode build') {
      const next = trimmed.split(' ')[1]! as AgentMode;
      setMode(next);
      modeRef.current = next;
      agentRef.current?.setMode(next);
      setLogs((prev) => [...prev, { kind: 'system', text: `mode \u2192 ${next}` }]);
      return;
    }

    if (trimmed.startsWith('/theme')) {
      const requested = trimmed.split(' ')[1];
      if (requested && THEME_NAMES.includes(requested)) {
        setThemeName(requested);
        setLogs((prev) => [...prev, { kind: 'system', text: `theme \u2192 ${requested}` }]);
      } else {
        setLogs((prev) => [
          ...prev,
          { kind: 'system', text: `Themes: ${THEME_NAMES.join(', ')} (current: ${themeName})\nUsage: /theme <name>`, meta: 'theme' },
        ]);
      }
      return;
    }

    if (trimmed === '/context') {
      const info = agentRef.current?.getContextInfo();
      const est = info?.estimatedTokens ?? 0;
      const max = info?.maxTokens ?? 0;
      const msgs = messagesRef.current.length;
      const pct = max > 0 ? Math.round((est / max) * 100) : 0;
      const files = info?.filesReferenced ?? [];
      const stats = tokenStatsRef.current;
      const totalCost = estimateCost(props.model, stats.inputTokens, stats.outputTokens);
      setLogs((prev) => [
        ...prev,
        {
          kind: 'system',
          text: [
            `context ~${est.toLocaleString()} / ${max.toLocaleString()} tokens (${pct}%)`,
            `messages ${msgs} \u00b7 queries ${stats.queries} \u00b7 tools ${stats.toolsRun}`,
            `mode ${info?.mode ?? 'build'} \u00b7 cost ${formatCost(totalCost)}`,
            ...(files.length > 0 ? [`referenced files: ${files.length}`, ...files.map((f) => `  ${f}`)] : []),
          ].join('\n'),
          meta: 'context',
        },
      ]);
      return;
    }

    if (trimmed === '/compact') {
      const before = messagesRef.current.length;
      agentRef.current?.compactManual(messagesRef.current, (ev) => {
        if (ev.type === 'compacted') {
          const { removed, kept } = ev.data as { removed: number; kept: number };
          setLogs((prev) => [...prev, { kind: 'system', text: `compacted \u2014 summarized ${removed}, kept ${kept}` }]);
        }
      });
      if (messagesRef.current.length === before) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'nothing to compact' }]);
      }
      return;
    }

    if (trimmed === '/commit') {
      if (!agentRef.current) return;
      const diff = await getGitDiff(props.cwd);
      if (!diff) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'no staged changes to commit' }]);
        return;
      }
      const message = generateCommitMessage(diff);
      const ok = await agentRef.current.autoCommit(message, props.cwd, new AbortController().signal);
      setLogs((prev) => [...prev, { kind: 'system', text: ok ? `committed \u2014 ${message}` : 'commit failed', meta: message }]);
      return;
    }

    if (trimmed === '/checkpoint' || trimmed.startsWith('/checkpoint ')) {
      if (!agentRef.current) return;
      const label = trimmed === '/checkpoint' ? `cp-${Date.now()}` : trimmed.slice('/checkpoint '.length).trim();
      const id = await agentRef.current.saveCheckpoint(label, messagesRef.current);
      setLogs((prev) => [...prev, { kind: 'system', text: `checkpoint \u2713 ${id} (${label})` }]);
      return;
    }

    if (trimmed === '/checkpoints') {
      if (!agentRef.current) return;
      const cps = agentRef.current.getCheckpoints();
      if (cps.length === 0) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'no checkpoints yet \u2014 use /checkpoint <label>' }]);
      } else {
        setLogs((prev) => [
          ...prev,
          {
            kind: 'system',
            text: cps.map((c) => `  ${c.id}  ${new Date(c.timestamp).toLocaleTimeString()}  ${c.label}`).join('\n'),
            meta: `checkpoints (${cps.length}) \u00b7 /rollback <id> to restore`,
          },
        ]);
      }
      return;
    }

    if (trimmed.startsWith('/rollback ')) {
      if (!agentRef.current) return;
      const id = trimmed.slice('/rollback '.length).trim();
      const restored = await agentRef.current.restoreCheckpoint(id);
      setLogs((prev) => [
        ...prev,
        ...(restored
          ? [{ kind: 'system' as const, text: `restored ${id} \u2014 ${restored.length} messages, files reverted` }]
          : [{ kind: 'system' as const, text: `checkpoint "${id}" not found` }]),
      ]);
      if (restored) messagesRef.current = restored;
      return;
    }

    if (trimmed === '/stats') {
      const stats = tokenStatsRef.current;
      const msgs = messagesRef.current.length;
      const totalCost = estimateCost(props.model, stats.inputTokens, stats.outputTokens);
      const elapsedMs = Date.now() - perfStartRef.current;
      const elapsed = new Date(elapsedMs).toISOString().substr(11, 8);
      const cps = agentRef.current?.getCheckpoints().length ?? 0;
      setLogs((prev) => [
        ...prev,
        {
          kind: 'system',
          text: [
            `messages   ${msgs}`,
            `queries    ${stats.queries}`,
            `tools run  ${stats.toolsRun}`,
            `input      ${stats.inputTokens.toLocaleString()} tok`,
            `output     ${stats.outputTokens.toLocaleString()} tok`,
            `cost       ${formatCost(totalCost)}`,
            `checkpoints ${cps}`,
            `elapsed    ${elapsed}`,
          ].join('\n'),
          meta: 'session stats',
        },
      ]);
      return;
    }

    if (trimmed.startsWith('/mem ')) {
      if (!agentRef.current) return;
      const body = trimmed.slice('/mem '.length).trim();
      const sepIdx = body.indexOf(':');
      if (sepIdx === -1) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'usage: /mem <key>: <value>' }]);
        return;
      }
      const key = body.slice(0, sepIdx).trim();
      const value = body.slice(sepIdx + 1).trim();
      const ok = await agentRef.current.saveMemory(key, value);
      setLogs((prev) => [...prev, { kind: 'system', text: ok ? `memory saved \u2713 ${key}` : 'failed to save memory' }]);
      return;
    }

    if (trimmed === '/undo') {
      if (!agentRef.current) return;
      try {
        const hash = await agentRef.current.revertLastCommit(props.cwd, new AbortController().signal);
        setLogs((prev) => [...prev, { kind: 'system', text: `reverted ${hash}` }]);
      } catch (e) {
        setLogs((prev) => [...prev, { kind: 'system', text: `undo failed \u2014 ${e instanceof Error ? e.message : String(e)}` }]);
      }
      return;
    }

    if (trimmed.startsWith('/restore ')) {
      const id = trimmed.slice('/restore '.length).trim();
      const store = storeRef.current;
      if (!store) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'session persistence not configured' }]);
        return;
      }
      const session = await store.get(id);
      if (!session) {
        setLogs((prev) => [...prev, { kind: 'system', text: `session "${id}" not found` }]);
        return;
      }
      messagesRef.current = [...session.messages];
      sessionRef.current = id;
      setLogs([
        { kind: 'system', text: `restored session ${id} \u2014 ${session.messages.length} messages` },
        ...session.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            kind: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
            text: m.content,
          })),
      ]);
      return;
    }

    if (trimmed.startsWith('/search ')) {
      const query = trimmed.slice('/search '.length).trim();
      const store = storeRef.current;
      if (!store) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'session persistence not configured' }]);
        return;
      }
      const matches = await store.searchContent(query);
      if (matches.length === 0) {
        setLogs((prev) => [...prev, { kind: 'system', text: `no sessions matching "${query}"` }]);
      } else {
        setLogs((prev) => [
          ...prev,
          {
            kind: 'system',
            text: matches.slice(0, 10).map((m) => `  ${m.id}  ${new Date(m.updatedAt).toLocaleTimeString()}  ${m.title ?? '(untitled)'}`).join('\n'),
            meta: `sessions matching "${query}"`,
          },
        ]);
      }
      return;
    }

    if (trimmed === '/sessions') {
      const store = storeRef.current;
      if (!store) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'session persistence not configured' }]);
        return;
      }
      const list = await store.list();
      if (list.length === 0) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'no saved sessions' }]);
      } else {
        setLogs((prev) => [
          ...prev,
          {
            kind: 'system',
            text: list.map((s) => `  ${s.id}  ${new Date(s.updatedAt).toLocaleString()}  ${s.title ?? '(untitled)'}`).join('\n'),
            meta: `saved sessions (${list.length}) \u00b7 /restore <id> to resume`,
          },
        ]);
      }
      return;
    }

    if (trimmed.startsWith('/export')) {
      const store = storeRef.current;
      const sessionId = sessionRef.current;
      if (!store || !sessionId) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'no active session to export' }]);
        return;
      }
      const session = await store.get(sessionId);
      if (!session) return;
      const md = await store.exportMarkdown(session);
      const filename = trimmed.split(' ')[1] ?? `daya-session-${sessionId}.md`;
      await writeFile(join(props.cwd, filename), md, 'utf8');
      setLogs((prev) => [...prev, { kind: 'system', text: `exported \u2713 ${filename}` }]);
      return;
    }

    if (trimmed.startsWith('/model ')) {
      const next = trimmed.slice('/model '.length).trim();
      if (!next) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'usage: /model <model-id>' }]);
        return;
      }
      const p = { ...propsRef.current, model: next };
      propsRef.current = p;
      agentRef.current = new Agent({
        provider: makeProvider(p),
        tools: defaultTools(),
        permissions: new BridgePermissionChecker(permissionHandlerRef),
        cwd: p.cwd,
        conventions: loadConventionsSync(p.cwd),
        lintCmd: p.lintCmd,
        testCmd: p.testCmd,
        autoCommit: p.autoCommit,
        architectModel: p.architectModel,
        memoryFile: join(p.cwd, 'DAYA.md'),
      });
      setLogs((prev) => [...prev, { kind: 'system', text: `model \u2192 ${next}` }]);
      return;
    }

    // Custom slash command
    if (trimmed.startsWith('/')) {
      const cmdName = trimmed.slice(1).split(' ')[0]!;
      const template = customPromptsRef.current[cmdName];
      if (template) {
        const arg = trimmed.slice(cmdName.length + 2).trim();
        const prompt = arg ? `${template}\n\nUser request: ${arg}` : template;
        await runAgent(prompt, trimmed);
        return;
      }
      setLogs((prev) => [...prev, { kind: 'system', text: `unknown command: /${cmdName} \u2014 use /help` }]);
      return;
    }

    await runAgent(trimmed, trimmed);
  };

  const runAgent = async (prompt: string, displayText: string): Promise<void> => {
    setLogs((prev) => [...prev, { kind: 'user', text: displayText }]);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let assistantBuffer = '';
    tokenStatsRef.current.queries += 1;
    const inputBefore = messagesRef.current.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0);

    try {
      await agentRef.current!.run(prompt, {
        signal: ctrl.signal,
        history: messagesRef.current,
        mode: modeRef.current,
        onEvent: (ev: AgentEvent) => {
          switch (ev.type) {
            case 'assistant_text_delta': {
              assistantBuffer += (ev.data as { delta: string }).delta;
              tokenStatsRef.current.outputTokens += Math.max(1, Math.ceil((ev.data as { delta: string }).delta.length / 4));
              setLogs((prev) => upsertAssistant(prev, assistantBuffer));
              break;
            }
            case 'tool_started': {
              const { name } = ev.data as { name: string; input: unknown };
              toolTimingsRef.current[name] = { name, startedAt: Date.now() };
              setLogs((prev) => [...prev, { kind: 'tool', text: `${name}` }]);
              break;
            }
            case 'tool_finished': {
              const { name, result } = ev.data as { name: string; result: { output: string; isError?: boolean } };
              tokenStatsRef.current.toolsRun += 1;
              const timing = toolTimingsRef.current[name];
              const elapsed = timing ? `${((Date.now() - timing.startedAt) / 1000).toFixed(1)}s` : '';
              delete toolTimingsRef.current[name];
              const icon = result.isError ? '\u2717' : '\u2713';
              setLogs((prev) => [
                ...prev,
                {
                  kind: 'tool',
                  text: `${icon} ${name}${elapsed ? `  \u00b7 ${elapsed}` : ''}`,
                  meta: result.output,
                  metaColor: result.isError ? theme.accents.error : theme.text.muted,
                },
              ]);
              break;
            }
            case 'compacted': {
              const { removed, kept } = ev.data as { removed: number; kept: number };
              setLogs((prev) => [...prev, { kind: 'system', text: `compacted \u2014 summarized ${removed}, kept ${kept}` }]);
              break;
            }
            case 'diagnostics': {
              const { file, diagnostics } = ev.data as {
                file: string;
                diagnostics: Array<{ line: number; column: number; severity: string; message: string; source: string }>;
              };
              const errors = diagnostics.filter((d) => d.severity === 'error');
              const warnings = diagnostics.filter((d) => d.severity === 'warning');
              if (errors.length + warnings.length > 0) {
                setLogs((prev) => [
                  ...prev,
                  {
                    kind: 'diag',
                    text: `${errors.length} error${errors.length === 1 ? '' : 's'} \u00b7 ${warnings.length} warning${warnings.length === 1 ? '' : 's'} \u2014 ${file}`,
                    meta: diagnostics.map((d) => `  ${d.line}:${d.column}  ${d.severity === 'error' ? '\u2717' : '\u26a0'} ${d.source}  ${d.message}`).join('\n'),
                    metaColor: errors.length > 0 ? theme.accents.error : theme.accents.warning,
                  },
                ]);
              }
              break;
            }
            case 'done': {
              messagesRef.current = (ev.data as { messages: Message[] }).messages;
              break;
            }
            case 'error': {
              setLogs((prev) => [...prev, { kind: 'system', text: `error \u2014 ${String(ev.data)}`, metaColor: theme.accents.error }]);
              break;
            }
            default:
              break;
          }
        },
      });
      const inputAfter = messagesRef.current.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0);
      tokenStatsRef.current.inputTokens += Math.max(0, inputAfter - inputBefore);
    } catch (e) {
      setLogs((prev) => [...prev, { kind: 'system', text: `error \u2014 ${e instanceof Error ? e.message : String(e)}`, metaColor: theme.accents.error }]);
    } finally {
      setBusy(false);
      await saveSession();
    }
  };

  const modeColor = mode === 'plan' ? theme.accents.plan : theme.accents.build;
  const stats = tokenStatsRef.current;

  return (
    <Box flexDirection="column">
      {/* Minimal header (Claude Code style — no box, no background) */}
      <Box justifyContent="space-between" width="100%" marginBottom={1}>
        <Text color={theme.text.muted}>
          {'\u273b'} DAYA Code
        </Text>
        <Text color={theme.text.muted}>
          {props.provider} {'\u00b7'} {props.model} {'\u00b7'} {themeName}
        </Text>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" height={19} flexGrow={1}>
        {logs.map((entry, i) => (
          <MessageRow key={i} entry={entry} theme={theme} />
        ))}
        {busy && (
          <Box marginTop={1}>
            <Text color={theme.text.muted}>
              <Spinner type="dots" /> working
            </Text>
          </Box>
        )}
        {permissionPrompt && (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.accents.warning}>
              {'\u26a0'} {describeAction(permissionPrompt.action)}
            </Text>
            <Text color={theme.text.muted}>  y = yes {'\u00b7'} a = always {'\u00b7'} n = no</Text>
          </Box>
        )}
      </Box>

      {/* Prompt */}
      <Box marginTop={1}>
        <Text color={modeColor}>{mode === 'plan' ? '\u25e6' : '\u25cf'} </Text>
        <TextInput
          value={permissionPrompt ? permissionInput : input}
          onChange={permissionPrompt ? setPermissionInput : setInput}
          onSubmit={onSubmit}
          placeholder={busy ? '(working\u2026)' : permissionPrompt ? 'y / a / n' : 'Ask DAYA something\u2026'}
        />
      </Box>

      {/* Status bar (bare, no border) */}
      <Box justifyContent="space-between" width="100%" marginTop={1}>
        <Text color={theme.text.muted}>
          {mode === 'plan' ? 'plan' : 'build'} {'\u00b7'} ctrl+c exit {'\u00b7'} /help {'\u00b7'} tab plan/build
        </Text>
        <Text color={theme.text.muted}>
          {((stats.inputTokens + stats.outputTokens) / 1000).toFixed(1)}k tokens {'\u00b7'}{' '}
          {formatCost(estimateCost(props.model, stats.inputTokens, stats.outputTokens))} {'\u00b7'} {stats.toolsRun} tools
        </Text>
      </Box>
    </Box>
  );
}

function describeAction(action: PermissionAction): string {
  switch (action.kind) {
    case 'bash':
      return `run: ${(action as { command: string }).command}`;
    case 'write_file':
      return `write: ${(action as { path: string }).path}`;
    case 'edit_file':
      return `edit: ${(action as { path: string }).path}`;
  }
}

class BridgePermissionChecker implements PermissionChecker {
  constructor(
    private ref: React.RefObject<
      ((action: PermissionAction) => Promise<PermissionDecision>) | undefined
    >,
  ) {}

  async check(action: PermissionAction): Promise<PermissionDecision> {
    const handler = this.ref.current;
    if (!handler) return { allowed: true };
    return handler(action);
  }
}

function MessageRow({ entry, theme }: { entry: LogEntry; theme: DayaTheme }): React.ReactElement {
  const isSpeech = entry.kind === 'user' || entry.kind === 'assistant';

  const color =
    entry.kind === 'user'
      ? theme.roles.user
      : entry.kind === 'assistant'
        ? theme.text.primary
        : entry.kind === 'tool'
          ? entry.metaColor ?? theme.text.muted
          : entry.kind === 'diag'
            ? entry.metaColor ?? theme.accents.warning
            : entry.kind === 'diff'
              ? theme.roles.diff
              : theme.text.muted;

  const prefix =
    entry.kind === 'tool'
      ? ''
      : entry.kind === 'diag'
        ? '\u26a0'
        : entry.kind === 'diff'
          ? '\u25b8'
          : entry.kind === 'system'
            ? '\u00b7'
            : '';

  return (
    <Box flexDirection="column" marginBottom={isSpeech ? 1 : 0}>
      <Box>
        {prefix && (
          <Text color={color}>
            {prefix}{' '}
          </Text>
        )}
        <Text color={color} wrap="wrap">
          {entry.text}
        </Text>
      </Box>
      {entry.meta && (
        <Text color={entry.metaColor ?? theme.text.muted} wrap="wrap">
          {'  '}{'\u2514'} {entry.meta}
        </Text>
      )}
    </Box>
  );
}

function loadConventionsSync(cwd: string): string | undefined {
  const candidates = ['DAYA.md', 'AGENTS.md', 'CLAUDE.md', '.daya/conventions.md'];
  for (const name of candidates) {
    try {
      const p = join(cwd, name);
      if (existsSync(p)) {
        const content = readFileSync(p, 'utf8');
        if (content.trim().length > 0) return content;
      }
    } catch {
      // skip
    }
  }
  return undefined;
}

function upsertAssistant(logs: LogEntry[], text: string): LogEntry[] {
  const idx = [...logs].reverse().findIndex((l) => l.kind === 'assistant' && l.meta === 'streaming');
  if (idx === -1) {
    return [...logs, { kind: 'assistant', text, meta: 'streaming' }];
  }
  const realIdx = logs.length - 1 - idx;
  const next = [...logs];
  const existing = next[realIdx];
  if (existing) {
    next[realIdx] = { ...existing, text };
  }
  return next;
}