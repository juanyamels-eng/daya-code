import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  Agent,
  defaultTools,
  createProvider,
  SessionStore,
  loadConventions,
  estimateCost,
  formatCost,
  getGitDiff,
  generateCommitMessage,
  projectMemory,
  type LocalMemory,
  type AgentEvent,
  type AgentMode,
  type Message,
  type PermissionChecker,
  type Provider,
  type ProviderName,
  type PermissionAction,
  type PermissionDecision,
} from '@daya-code/core';
import { getTheme, DAYA_BRAND, DAYA_BRAND_SOFT, THEME_NAMES, DEFAULT_THEME, type DayaTheme } from './themes.js';
import { glyphs, type GlyphSet } from './glyphs.js';
import type { EditReviewChange } from '@daya-code/core';

// Single source of truth for the version shown in the TUI header.
const DAYA_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ? `v${pkg.version}` : 'dev';
  } catch {
    return 'dev';
  }
})();

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
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'diff' | 'diag' | 'section' | 'meta';
  text: string;
  meta?: string;
  metaColor?: string;
}

interface PermissionPrompt {
  action: PermissionAction;
  resolve: (decision: PermissionDecision) => void;
}

interface ReviewPrompt {
  change: EditReviewChange;
  resolve: (approved: boolean) => void;
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
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const g = glyphs();
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<AgentMode>('build');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [runningTool, setRunningTool] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{ mode: string; dur: string; cost: string } | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [permissionPrompt, setPermissionPrompt] = useState<PermissionPrompt | null>(null);
  const [permissionInput, setPermissionInput] = useState('');
  const [reviewPrompt, setReviewPrompt] = useState<ReviewPrompt | null>(null);
  const reviewModeRef = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [themeName, setThemeName] = useState(props.theme ?? DEFAULT_THEME);
  const theme = getTheme(themeName);
  const agentRef = useRef<Agent>();
  const propsRef = useRef(props);
  propsRef.current = props;
  const messagesRef = useRef<Message[]>([]);
  const abortRef = useRef<AbortController>();
  const busyRef = useRef(false);
  const sessionRef = useRef<string | null>(null);
  const storeRef = useRef<SessionStore | null>(null);
  const projectMemoryRef = useRef<ReturnType<typeof projectMemory> | null>(null);
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
  const runStartRef = useRef<number>(Date.now());

  const handlePermission = useCallback(async (action: PermissionAction): Promise<PermissionDecision> => {
    return new Promise((resolve) => {
      setPermissionPrompt({ action, resolve });
      setPermissionInput('');
    });
  }, []);
  permissionHandlerRef.current = handlePermission;

  const handleReviewApproval = useCallback((change: EditReviewChange): Promise<boolean> => {
    return new Promise((resolve) => {
      setReviewPrompt({ change, resolve });
    });
  }, []);

  const buildAgent = (p: AppProps): Agent => {
    const pm = projectMemoryRef.current ?? projectMemory(p.cwd);
    projectMemoryRef.current = pm;
    return new Agent({
      provider: makeProvider(p),
      tools: defaultTools(),
      permissions: new BridgePermissionChecker(permissionHandlerRef),
      cwd: p.cwd,
      conventions: loadConventionsSync(p.cwd),
      lintCmd: p.lintCmd,
      testCmd: p.testCmd,
      autoCommit: p.autoCommit,
      watchFiles: true,
      architectModel: p.architectModel,
      memoryFile: join(p.cwd, 'DAYA.md'),
      daya: {
        memory: pm.memory,
        namespace: pm.namespace,
        autoRecall: true,
      },
      requestApproval: reviewModeRef.current ? handleReviewApproval : undefined,
    });
  };

  // Rebuild the agent without losing the working one if composition fails
  // (e.g. a provider configured without an API key). The old agent stays live.
  const safeRebuildAgent = (p: AppProps, arrow: string): boolean => {
    try {
      agentRef.current = buildAgent(p);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLogs((prev) => [...prev, { kind: 'system', text: `failed to rebuild agent ${arrow} ${msg}` }]);
      return false;
    }
  };

  useEffect(() => {
    const store = props.sessionsDir ? new SessionStore(props.sessionsDir) : null;
    storeRef.current = store;
    customPromptsRef.current = loadCustomPrompts(props.cwd);

    (async () => {
      try {
        agentRef.current = buildAgent(props);
        agentRef.current.startWatcher((changes) => {
          for (const change of changes) {
            setLogs((prev) => [...prev, { kind: 'system', text: `${change.type} ${change.path} (external)` }]);
          }
        });

        if (store) {
          await store.init();
          const session = await store.create(props.cwd);
          sessionRef.current = session.meta.id;
        }

        // No seeded lines: the empty state renders a branded welcome instead.
        setLogs([]);
      } catch (e) {
        setInitError(e instanceof Error ? e.message : String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live clock so the elapsed time keeps ticking while a run is in progress.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [busy]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (key.ctrl && input === 'l') {
      setLogs([]);
      setLastRun(null);
      return;
    }
    if (logs.length > 0 && key.upArrow) {
      const budget = Math.max(4, Math.max(6, rows - 8) - 3);
      setScrollTop((v) => Math.min(Math.max(0, logs.length - budget), v + 1));
      return;
    }
    if (key.downArrow) {
      setScrollTop((v) => Math.max(0, v - 1));
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
      setLogs((prev) => [...prev, { kind: 'system', text: `mode ${g.arrow} ${next}` }]);
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
    } catch (e) {
      setLogs((prev) => [...prev, { kind: 'system', text: `warning: could not save session — ${e instanceof Error ? e.message : String(e)}` }]);
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
    if (reviewPrompt) {
      const approved = ['y', 'yes', ''].includes(text.trim().toLowerCase());
      const pending = reviewPrompt;
      setReviewPrompt(null);
      setInput('');
      pending.resolve(approved);
      return;
    }
    if (permissionPrompt) {
      onPermissionSubmit(text);
      return;
    }
    // One agent run at a time: don't lose the typed command while the agent
    // is still working on the previous one.
    if (busyRef.current) {
      setLogs((prev) => [...prev, { kind: 'system', text: 'still working… use Ctrl+C to stop the current run, then retry' }]);
      setInput(text);
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
      const W = 18;
      const sections: Array<[string, Array<[string, string]>]> = [
        ['Session', [
          ['/quit', 'exit and save'],
          ['/clear', 'clear screen'],
          ['/export [f]', 'export to markdown'],
          ['/summary', 'files, cost, time'],
          ['/stats', 'session analytics'],
        ]],
        ['Mode & view', [
          ['/mode plan', 'read-only planning'],
          ['/mode build', 'execute changes'],
          ['/theme', `switch theme ${g.bullet} ${THEME_NAMES.join(', ')}`],
          ['/model <id>', 'switch model'],
          ['Tab', 'plan ' + g.swap + ' build'],
          ['↑/↓', 'scroll history'],
          ['Shift+Enter', 'newline in prompt'],
          ['Ctrl+L', 'clear panel'],
        ]],
        ['Context', [
          ['/context', 'tokens, cost, files'],
          ['/compact', 'summarize history'],
        ]],
        ['Git & review', [
          ['/commit', 'preview diff, then commit'],
          ['/undo', 'revert last commit'],
          ['/review', 'toggle hunk review'],
        ]],
        ['Memory & checkpoints', [
          ['/mem <k>: <v>', 'save to DAYA.md'],
          ['/memlist', 'list project memory'],
          ['/memforget <k>', 'delete a memory'],
          ['/checkpoint', 'save state'],
          ['/checkpoints', 'list checkpoints'],
          ['/rollback <id>', 'restore state'],
        ]],
        ['Sessions', [
          ['/restore <id>', 'resume a session'],
          ['/search <q>', 'search sessions'],
          ['/sessions', 'list saved sessions'],
          ['@path/file', 'attach a file'],
        ]],
      ];
      const helpLogs: LogEntry[] = [{ kind: 'section', text: 'Commands' }];
      for (const [title, cmds] of sections) {
        helpLogs.push({ kind: 'section', text: title });
        helpLogs.push({ kind: 'system', text: cmds.map(([cmd, desc]) => `  ${cmd.padEnd(W)} ${desc}`).join('\n') });
      }
      if (customCmds.length > 0) {
        helpLogs.push({ kind: 'section', text: 'Custom prompts' });
        helpLogs.push({
          kind: 'system',
          text: customCmds.map((c) => `  /${c}${' '.repeat(Math.max(1, W - c.length - 1))}${c === 'architect' ? 'two-pass plan → execute' : 'run custom prompt'}`).join('\n'),
        });
      }
      helpLogs.push({
        kind: 'system',
        text: `Tip: keep ${g.hairline}${g.hairline}${g.hairline} visually separated runs, use Ctrl+L to clear, and /theme to switch palettes.`,
        metaColor: theme.text.muted,
      });
      setLogs((prev) => [...prev, ...helpLogs]);
      return;
    }

    if (trimmed === '/mode plan' || trimmed === '/mode build') {
      const next = trimmed.split(' ')[1]! as AgentMode;
      setMode(next);
      modeRef.current = next;
      agentRef.current?.setMode(next);
setLogs((prev) => [...prev, { kind: 'system', text: `mode ${g.arrow} ${next}` }]);
        return;
      }

      if (trimmed.startsWith('/theme')) {
      const requested = trimmed.split(' ')[1];
      if (requested && THEME_NAMES.includes(requested)) {
        setThemeName(requested);
        setLogs((prev) => [...prev, { kind: 'system', text: `theme ${g.arrow} ${requested}` }]);
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
            `messages ${msgs} ${g.bullet} queries ${stats.queries} ${g.bullet} tools ${stats.toolsRun}`,
            `mode ${info?.mode ?? 'build'} ${g.bullet} cost ${formatCost(totalCost)}`,
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
          setLogs((prev) => [...prev, { kind: 'system', text: `compacted ${g.dash} summarized ${removed}, kept ${kept}` }]);
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
      setLogs((prev) => [...prev, { kind: 'diff', text: `commit preview ${g.dash} ${message}`, meta: truncateDiff(diff, 40) }]);
      const ok = await agentRef.current.autoCommit(message, props.cwd, new AbortController().signal, { force: true });
      setLogs((prev) => [...prev, { kind: 'system', text: ok ? `committed ${g.dash} ${message}` : 'commit failed' }]);
      return;
    }

    if (trimmed === '/checkpoint' || trimmed.startsWith('/checkpoint ')) {
      if (!agentRef.current) return;
      const label = trimmed === '/checkpoint' ? `cp-${Date.now()}` : trimmed.slice('/checkpoint '.length).trim();
      const id = await agentRef.current.saveCheckpoint(label, messagesRef.current);
      setLogs((prev) => [...prev, { kind: 'system', text: `checkpoint ${g.check} ${id} (${label})` }]);
      return;
    }

    if (trimmed === '/checkpoints') {
      if (!agentRef.current) return;
      const cps = agentRef.current.getCheckpoints();
      if (cps.length === 0) {
        setLogs((prev) => [...prev, { kind: 'system', text: `no checkpoints yet ${g.dash} use /checkpoint <label>` }]);
      } else {
        setLogs((prev) => [
          ...prev,
          {
            kind: 'system',
            text: cps.map((c) => `  ${c.id}  ${new Date(c.timestamp).toLocaleTimeString()}  ${c.label}`).join('\n'),
            meta: `checkpoints (${cps.length}) ${g.bullet} /rollback <id> to restore`,
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
          ? [{ kind: 'system' as const, text: `restored ${id} ${g.dash} ${restored.length} messages, files reverted` }]
          : [{ kind: 'system' as const, text: `checkpoint "${id}" not found` }]),
      ]);
      if (restored) messagesRef.current = restored;
      return;
    }

    if (trimmed === '/summary') {
      const summary = buildSessionSummary();
      setLogs((prev) => [...prev, { kind: 'system', text: summary, meta: 'session summary' }]);
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
      setLogs((prev) => [...prev, { kind: 'system', text: ok ? `memory saved ${g.check} ${key}` : 'failed to save memory' }]);
      return;
    }

    if (trimmed === '/memlist' || trimmed === '/mems') {
      const pm = projectMemoryRef.current;
      if (!pm) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'project memory not configured' }]);
        return;
      }
      const entries = await pm.memory.list(pm.namespace, 50);
      if (entries.length === 0) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'no memories stored for this project yet' }]);
      } else {
        setLogs((prev) => [
          ...prev,
          {
            kind: 'system',
            text: entries.map((e) => `  ${e.key}: ${e.value}`).join('\n'),
            meta: `project memory (${entries.length}) ${g.bullet} auto-recalled each run ${g.bullet} /memforget <key> to delete`,
          },
        ]);
      }
      return;
    }

    if (trimmed.startsWith('/memforget ')) {
      const pm = projectMemoryRef.current;
      if (!pm) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'project memory not configured' }]);
        return;
      }
      const key = trimmed.slice('/memforget '.length).trim();
      const removed = await pm.memory.delete(pm.namespace, key);
      setLogs((prev) => [...prev, { kind: 'system', text: removed ? `memory deleted ${g.check} ${key}` : `no memory "${key}" found` }]);
      return;
    }

    if (trimmed === '/undo') {
      if (!agentRef.current) return;
      try {
        const hash = await agentRef.current.revertLastCommit(props.cwd, new AbortController().signal);
        setLogs((prev) => [...prev, { kind: 'system', text: `reverted ${hash}` }]);
      } catch (e) {
        setLogs((prev) => [...prev, { kind: 'system', text: `undo failed ${g.dash} ${e instanceof Error ? e.message : String(e)}` }]);
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
        { kind: 'system', text: `restored session ${id} ${g.dash} ${session.messages.length} messages` },
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
            meta: `saved sessions (${list.length}) ${g.bullet} /restore <id> to resume`,
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
      setLogs((prev) => [...prev, { kind: 'system', text: `exported ${g.check} ${filename}` }]);
      return;
    }

    if (trimmed.startsWith('/model ')) {
      const next = trimmed.slice('/model '.length).trim();
      if (!next) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'usage: /model <model-id>' }]);
        return;
      }
      const p = { ...propsRef.current, model: next };
      if (!safeRebuildAgent(p, g.arrow)) return;
      propsRef.current = p;
      setLogs((prev) => [...prev, { kind: 'system', text: `model ${g.arrow} ${next}` }]);
      return;
    }

    if (trimmed === '/review') {
      reviewModeRef.current = !reviewModeRef.current;
      const p = propsRef.current;
      if (!safeRebuildAgent(p, g.arrow)) return;
      setLogs((prev) => [...prev, { kind: 'system', text: `hunk review ${g.arrow} ${reviewModeRef.current ? 'ON' : 'OFF'}` }]);
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
      setLogs((prev) => [...prev, { kind: 'system', text: `unknown command: /${cmdName} ${g.dash} use /help` }]);
      return;
    }

    await runAgent(trimmed, trimmed);
  };

  const runAgent = async (prompt: string, displayText: string): Promise<void> => {
    runStartRef.current = Date.now();
    setScrollTop(0);
    setLastRun(null);
    setRunningTool(null);
    setLogs((prev) => [...prev, { kind: 'user', text: displayText }]);
    setBusy(true);
    busyRef.current = true;
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
              setRunningTool(name);
              break;
            }
            case 'tool_finished': {
              const { name, result } = ev.data as { name: string; result: { output: string; isError?: boolean } };
              tokenStatsRef.current.toolsRun += 1;
              const timing = toolTimingsRef.current[name];
              const elapsed = timing ? `${((Date.now() - timing.startedAt) / 1000).toFixed(1)}s` : '';
              delete toolTimingsRef.current[name];
              setRunningTool((cur) => (cur === name ? null : cur));
              const icon = result.isError ? g.cross : toolGlyph(name, g.safe);
              setLogs((prev) => [
                ...prev,
                {
                  kind: 'tool',
                  text: `${icon} ${name}${elapsed ? `  ${g.bullet} ${elapsed}` : ''}`,
                  meta: truncateOutput(result.output),
                  metaColor: result.isError ? theme.accents.error : theme.text.muted,
                },
              ]);
              break;
            }
            case 'compacted': {
              const { removed, kept } = ev.data as { removed: number; kept: number };
              setLogs((prev) => [...prev, { kind: 'system', text: `compacted ${g.dash} summarized ${removed}, kept ${kept}` }]);
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
                    text: `${errors.length} error${errors.length === 1 ? '' : 's'} ${g.bullet} ${warnings.length} warning${warnings.length === 1 ? '' : 's'} ${g.dash} ${file}`,
                    meta: diagnostics.map((d) => `  ${d.line}:${d.column}  ${d.severity === 'error' ? g.cross : g.warn} ${d.source}  ${d.message}`).join('\n'),
                    metaColor: errors.length > 0 ? theme.accents.error : theme.accents.warning,
                  },
                ]);
              }
              break;
            }
            case 'done': {
              messagesRef.current = (ev.data as { messages: Message[] }).messages;
              setLogs((prev) => finalizeStreaming(prev));
              const doneDur = ((Date.now() - runStartRef.current) / 1000).toFixed(1);
              const doneCost = formatCost(
                estimateCost(props.model, tokenStatsRef.current.inputTokens, tokenStatsRef.current.outputTokens),
              );
              setLastRun({ mode: modeRef.current, dur: doneDur, cost: doneCost });
              break;
            }
            case 'error': {
              setLogs((prev) => [...prev, { kind: 'system', text: `error ${g.dash} ${String(ev.data)}`, metaColor: theme.accents.error }]);
              break;
            }
            default:
              break;
          }
        },
      });
      const inputAfter = messagesRef.current.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0);
      tokenStatsRef.current.inputTokens += Math.max(0, inputAfter - inputBefore);
      await agentRef.current!.persistMemories(messagesRef.current);
    } catch (e) {
      setLogs((prev) => [...prev, { kind: 'system', text: `error ${g.dash} ${e instanceof Error ? e.message : String(e)}`, metaColor: theme.accents.error }]);
      // Put the failed command back in the input box so it can be retried
      // or edited instead of being lost.
      setInput(displayText);
    } finally {
      busyRef.current = false;
      setBusy(false);
      await saveSession();
    }
  };

  const buildSessionSummary = (): string => {
    const stats = tokenStatsRef.current;
    const msgs = messagesRef.current;
    const changed = new Map<string, string>();
    for (const m of msgs) {
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (tc.name === 'write_file' || tc.name === 'edit_file') {
            const p = (tc.input as Record<string, unknown>)?.path;
            if (typeof p === 'string') changed.set(p, tc.name);
          }
        }
      }
    }
    const cost = estimateCost(props.model, stats.inputTokens, stats.outputTokens);
    const elapsedMs = Date.now() - perfStartRef.current;
    const elapsed = new Date(elapsedMs).toISOString().substr(11, 8);
    const lines: string[] = [
      `Session summary`,
      `  messages  ${msgs.length}`,
      `  queries   ${stats.queries}`,
      `  tools run ${stats.toolsRun}`,
      `  cost      ${formatCost(cost)}`,
      `  elapsed   ${elapsed}`,
    ];
    if (changed.size > 0) {
      lines.push(`  files touched (${changed.size})`);
      for (const [p, kind] of changed) lines.push(`    ${kind === 'write_file' ? 'W' : 'E'}  ${p}`);
    } else {
      lines.push('  files touched  (none)');
    }
    return lines.join('\n');
  };

  const modeColor = mode === 'plan' ? theme.accents.plan : theme.accents.build;
  const stats = tokenStatsRef.current;
  const info = agentRef.current?.getContextInfo();
  const maxTokens = info?.maxTokens ?? 0;
  const usedTokens = stats.inputTokens + stats.outputTokens;
  const contextPct = maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 100)) : 0;
  const ctxFillN = Math.round((contextPct / 100) * 10);
  const ctxColor = contextPct >= 90 ? theme.accents.error : contextPct >= 70 ? theme.accents.warning : theme.accents.info;
  const projName = basename(props.cwd);

  const panelHeight = Math.max(6, rows - 8);
  const logBudget = Math.max(4, panelHeight - 3);
  const maxScroll = Math.max(0, logs.length - logBudget);
  const st = Math.min(scrollTop, maxScroll);
  const visibleLogs = logs.slice(Math.max(0, logs.length - logBudget - st));
  const hidden = logs.length - visibleLogs.length;
  const elapsed = busy ? fmtElapsed(now - runStartRef.current) : fmtElapsed(Date.now() - perfStartRef.current);
  const statLeft = busy
    ? `${g.buildDot} running ${g.bullet} ${elapsed}`
    : `${mode === 'plan' ? g.planDot : g.buildDot} ${mode}`;
  const statExtra = busy ? 'ctrl+c to cancel' : `tab plan/build ${g.bullet} /help`;
  const ctxBar =
    maxTokens > 0
      ? columns >= 60
        ? `${g.blockFull.repeat(ctxFillN)}${g.blockEmpty.repeat(10 - ctxFillN)} ${contextPct}%  ${g.bullet}  `
        : `${contextPct}%  ${g.bullet}  `
      : '';
  const statRight = `${stats.toolsRun} tool${stats.toolsRun === 1 ? '' : 's'}  ${g.bullet}  ${(usedTokens / 1000).toFixed(1)}k  ${g.bullet}  ${formatCost(estimateCost(props.model, stats.inputTokens, stats.outputTokens))}`;
  const statusPad = Math.max(2, columns - statLeft.length - statExtra.length - ctxBar.length - statRight.length - 8);

  return (
    <Box flexDirection="column">
      {/* Header: brand | mode pills centered | provider/model (quiet) */}
      <Box justifyContent="space-between" width="100%" alignItems="center" marginBottom={1}>
        <Box alignItems="center">
          <Text color={DAYA_BRAND} bold>
            {g.brand} DAYA
          </Text>
          <Text color={theme.text.secondary}>{' Code '}</Text>
          <Text color={theme.text.primary} backgroundColor={DAYA_BRAND_SOFT}>
            {` ${DAYA_VERSION} `}
          </Text>
        </Box>
        <Box flexGrow={1} justifyContent="center">
          <Text
            color={mode === 'build' ? theme.window.panel : theme.text.muted}
            backgroundColor={mode === 'build' ? theme.accents.build : undefined}
            bold={mode === 'build'}
          >
            {` ${g.buildDot} build `}
          </Text>
          <Text color={theme.text.muted}>{' '}</Text>
          <Text
            color={mode === 'plan' ? theme.window.panel : theme.text.muted}
            backgroundColor={mode === 'plan' ? theme.accents.plan : undefined}
            bold={mode === 'plan'}
          >
            {` ${g.planDot} plan `}
          </Text>
        </Box>
        <Text color={theme.text.muted}>
          <Text color={theme.accents.info}>{g.right}</Text>
          {` ${projName} `}
          <Text color={theme.window.dim}>{g.bullet}</Text>
          {` ${props.model}`}
        </Text>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" height={panelHeight}>
        {initError && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color={theme.accents.error} bold>
              {`${g.warn} DAYA couldn't start`}
            </Text>
            <Text color={theme.text.secondary} wrap="wrap">
              {initError}
            </Text>
            <Text color={theme.text.muted} wrap="wrap">
              {`/model to switch provider ${g.bullet} /theme to restyle ${g.bullet} DAYA_GLYPHS=ascii for legacy terminals`}
            </Text>
          </Box>
        )}
        {logs.length === 0 && !busy && !permissionPrompt && !reviewPrompt && (
          <Welcome theme={theme} g={g} columns={columns} rows={rows} />
        )}
        {hidden > 0 && (
          <Text color={theme.text.muted}>
            {g.dots} {hidden} older {hidden === 1 ? 'line' : 'lines'} {g.dash} ↑ to scroll down
          </Text>
        )}
        {visibleLogs.map((entry, i) => (
          <MessageRow key={i} entry={entry} theme={theme} />
        ))}
        {busy && (
          <Box marginTop={1}>
            <Text color={theme.text.muted}>
              <Spinner type="dots" />{' '}
              <Text color={theme.accents.info}>{runningTool ?? (mode === 'plan' ? 'planning' : 'thinking')}</Text>
              {` ${g.bullet} ${elapsed}`}
            </Text>
          </Box>
        )}
        {permissionPrompt && (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.accents.warning}>
              {g.warn} {describeAction(permissionPrompt.action)}
            </Text>
            <Text color={theme.text.muted}>
              y = yes {g.bullet} a = always {g.bullet} n = no
            </Text>
          </Box>
        )}
        {reviewPrompt && (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.accents.warning}>
              {g.warn} review {reviewPrompt.change.kind} {g.dash} {reviewPrompt.change.path}
              {reviewPrompt.change.occurrences ? ` (${reviewPrompt.change.occurrences} match${reviewPrompt.change.occurrences > 1 ? 'es' : ''})` : ''}
            </Text>
            {reviewPrompt.change.old_text && (
              <ChangeDiff change={reviewPrompt.change} theme={theme} columns={columns} />
            )}
            {!reviewPrompt.change.old_text && (
              <DiffMeta text={`+ [write] ${reviewPrompt.change.new_text.slice(0, 120)}${reviewPrompt.change.new_text.length > 120 ? g.dots : ''}`} theme={theme} forced={theme.accents.success} />
            )}
            <Text color={theme.text.muted}>
              y = apply {g.bullet} n = reject
            </Text>
          </Box>
        )}
        {lastRun && !busy && !permissionPrompt && !reviewPrompt && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.window.dim}>{g.hairline.repeat(Math.max(8, columns - 4))}</Text>
            <Text color={theme.text.secondary}>
              <Text color={theme.accents.success} bold>{`${g.check} done`}</Text>
              {`  ${g.bullet}  ${lastRun.mode}  ${g.bullet}  ${lastRun.dur}  ${g.bullet}  ${lastRun.cost}`}
            </Text>
            <Text color={theme.window.dim}>{g.hairline.repeat(Math.max(8, columns - 4))}</Text>
          </Box>
        )}
      </Box>

      {/* Context near-limit warning */}
      {maxTokens > 0 && contextPct >= 75 && !busy && !permissionPrompt && !reviewPrompt && (
        <Box marginTop={1}>
          <Text color={theme.accents.warning}>
            {`${g.warn} context ${contextPct}% ${g.dash} near the limit, ask DAYA to summarize`}
          </Text>
        </Box>
      )}

      {/* Prompt */}
      <Box marginTop={1}>
        <Text color={modeColor}>{mode === 'plan' ? g.planDot : g.buildDot} </Text>
        <TextInput
          value={permissionPrompt ? permissionInput : input}
          onChange={permissionPrompt ? setPermissionInput : setInput}
          onSubmit={onSubmit}
          placeholder={busy ? `(working${g.dots})` : reviewPrompt ? 'y = apply / n = reject' : permissionPrompt ? 'y / a / n' : `Ask DAYA something${g.dots}`}
        />
      </Box>

      {/* Status bar: full-width strip with mode, ctx meter and stats */}
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.window.dim}>{g.hairline.repeat(Math.max(8, columns - 2))}</Text>
        <Text wrap="truncate" backgroundColor={theme.window.headerBg}>
          <Text color={modeColor} bold={busy}>{` ${statLeft}`}</Text>
          <Text color={theme.text.muted}>
            {`  ${statExtra}`}
            {' '.repeat(statusPad)}
          </Text>
          {maxTokens > 0 && <Text color={ctxColor}>{ctxBar}</Text>}
          <Text color={theme.text.muted}>{statRight}</Text>
        </Text>
      </Box>
    </Box>
  );
}

const TOOL_GLYPHS_PRETTY: Record<string, string> = {
  bash: '$',
  view: '⌕',
  read_file: '⌕',
  glob: '*',
  grep: '∷',
  write_file: '↳',
  edit_file: '✎',
  apply_patch: '%',
  patch: '%',
  webfetch: '↗',
  web_fetch: '↗',
  websearch: '◈',
  web_search: '◈',
  todo_write: '☑',
  todo: '☑',
};

const TOOL_GLYPHS_ASCII: Record<string, string> = {
  bash: '$',
  grep: '>',
  write_file: '>',
  edit_file: '*',
  apply_patch: '%',
  patch: '%',
  todo_write: '[ ]',
  todo: '[ ]',
  default: '*',
};

function toolGlyph(name: string, safe: boolean): string {
  if (safe) return TOOL_GLYPHS_ASCII[name] ?? TOOL_GLYPHS_ASCII['default']!;
  return TOOL_GLYPHS_PRETTY[name] ?? '⚙';
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

export function MessageRow({ entry, theme }: { entry: LogEntry; theme: DayaTheme }): React.ReactElement {
  const g = glyphs();
  const isSpeech = entry.kind === 'user' || entry.kind === 'assistant';
  const toolErr =
    entry.kind === 'tool' &&
    (entry.text.startsWith(g.cross) || /^(fail|err|error)/i.test(entry.text.trimStart()));

  const color =
    entry.kind === 'user'
      ? theme.roles.user
      : entry.kind === 'assistant'
        ? theme.text.primary
        : entry.kind === 'section'
          ? theme.accents.info
          : entry.kind === 'tool'
            ? entry.metaColor ?? theme.text.muted
            : entry.kind === 'diag'
              ? entry.metaColor ?? theme.accents.warning
              : entry.kind === 'diff'
                ? theme.roles.diff
                : theme.text.muted;

  const prefix =
    entry.kind === 'user'
      ? ''
      : entry.kind === 'tool'
        ? ''
        : entry.kind === 'diag'
          ? g.warn
          : entry.kind === 'diff'
            ? ''
            : entry.kind === 'section'
              ? ''
              : entry.kind === 'system'
                ? g.bullet
                : '';

  return (
    <Box flexDirection="column" marginBottom={isSpeech ? 1 : 0}>
      <Box paddingLeft={entry.kind === 'section' ? 0 : 1}>
        {prefix && (
          <Text color={color}>
            {prefix}{' '}
          </Text>
        )}
        {entry.kind === 'assistant' ? (
          <Box flexDirection="column">
            <Text color={DAYA_BRAND} bold>
              {`${g.brand} DAYA`}
            </Text>
            <MarkdownLines text={entry.text} theme={theme} />
          </Box>
        ) : entry.kind === 'diff' && entry.meta ? null : entry.kind === 'user' ? (
          entry.text.split('\n').map((line, i) => (
            <Text key={i} wrap="wrap" backgroundColor={theme.window.panel} color={theme.text.primary}>
              <Text color={theme.roles.user}>{g.userBar}{' '}</Text>
              <Text color={theme.text.primary}>{line || ' '}</Text>
            </Text>
          ))
        ) : entry.kind === 'tool' ? (
          <Text color={toolErr ? theme.accents.error : theme.text.secondary} wrap="wrap">
            {entry.text}
          </Text>
        ) : entry.kind === 'section' ? (
          <Text color={color} bold wrap="wrap">
            {`${g.hairline}${g.hairline} ${entry.text} ${g.hairline}${g.hairline}`}
          </Text>
        ) : (
          <Text color={color} wrap="wrap">
            {entry.text}
          </Text>
        )}
      </Box>
      {entry.meta && (
        <Box paddingLeft={entry.kind === 'tool' ? 1 : 2}>
          <DiffMeta text={entry.meta} theme={theme} forced={entry.metaColor} />
        </Box>
      )}
    </Box>
  );
}

/** Branded empty state shown until the first message is sent. */
function Welcome({
  theme,
  g,
  columns,
  rows,
}: {
  theme: DayaTheme;
  g: GlyphSet;
  columns: number;
  rows: number;
}): React.ReactElement | null {
  if (rows < 16) return null;
  const brand = DAYA_BRAND;
  // Block-letter "DAYA" (16 cols). Falls back to plain text on non-unicode terms.
  const logo = g.safe
    ? [
        `${g.blockFull}${g.blockFull}${g.blockFull}   ${g.blockFull}  ${g.blockFull} ${g.blockFull}   ${g.blockFull} `,
        `${g.blockFull}  ${g.blockFull} ${g.blockFull} ${g.blockFull} ${g.blockFull} ${g.blockFull} ${g.blockFull} `,
        `${g.blockFull}${g.blockFull}${g.blockFull}  ${g.blockFull}${g.blockFull}${g.blockFull}  ${g.blockFull}  ${g.blockFull}${g.blockFull}${g.blockFull} `,
        `${g.blockFull}  ${g.blockFull} ${g.blockFull} ${g.blockFull}   ${g.blockFull}  ${g.blockFull} ${g.blockFull} `,
      ]
    : [undefined];
  const hints: Array<[string, string]> = [
    ['tab', `plan ${g.swap} build`],
    ['↑/↓', 'scroll'],
    ['/model', 'switch model'],
    ['/theme', 'pick palette'],
    ['@file', 'attach a file'],
    ['/mem', 'remember a fact'],
  ];
  const compact = columns < 60 || rows < 26;
  return (
    <Box flexDirection="column">
      {logo[0] === undefined ? (
        <Box justifyContent="center" marginBottom={1}>
          <Text color={brand} bold>
            DAYA
          </Text>
        </Box>
      ) : (
        logo.map((row, i) => (
          <Box key={i} justifyContent="center">
            <Text color={brand} bold>
              {row}
            </Text>
          </Box>
        ))
      )}
      <Box justifyContent="center" marginTop={1}>
        <Text color={theme.text.secondary}>images {g.bullet} web {g.bullet} docs {g.bullet} memory {g.dash} one terminal</Text>
      </Box>
      {!compact && (
        <Box justifyContent="center" marginTop={2}>
          <Box flexDirection="column">
            {Array.from({ length: 3 }, (_, r) => (
              <Box key={r}>
                {[0, 1]
                  .map((ci) => hints[r * 2 + ci])
                  .filter((h): h is [string, string] => h !== undefined)
                  .map(([k, v]) => (
                    <Box key={k} width={26}>
                      <Text color={brand} bold>{` ${k} `}</Text>
                      <Text color={theme.text.muted}>{v}</Text>
                    </Box>
                  ))}
              </Box>
            ))}
          </Box>
        </Box>
      )}
      {compact && (
        <Box justifyContent="center" marginTop={1}>
          <Text color={theme.text.muted}>
            {`tab ${g.swap} build  ·  ↑/↓ scroll  ·  /model switch  ·  /theme palette`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function DiffMeta({ text, theme, forced }: { text: string; theme: DayaTheme; forced?: string }): React.ReactElement {
  const g = glyphs();
  const lines = text.split('\n');
  // Per-file +N/−M tallies shown on each "diff --git" header line.
  const counts = new Map<number, { added: number; removed: number }>();
  if (!forced) {
    let cur = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]!.trimStart();
      if (t.startsWith('diff --git')) {
        cur = i;
        counts.set(i, { added: 0, removed: 0 });
      } else if (cur >= 0) {
        const c = counts.get(cur)!;
        if (t.startsWith('+') && !t.startsWith('+++')) c.added++;
        else if (t.startsWith('-') && !t.startsWith('---')) c.removed++;
      }
    }
  }
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const trimmed = line.trimStart();
        const { color, bold } = diffLineStyle(trimmed, theme, forced);
        let bg: string | undefined;
        if (!forced) {
          if (trimmed.startsWith('+')) bg = theme.diffBg.add;
          else if (trimmed.startsWith('-')) bg = theme.diffBg.rem;
          else if (trimmed.startsWith('@@') || trimmed.startsWith('diff --git') || trimmed.startsWith('---') || trimmed.startsWith('+++')) bg = theme.diffBg.ctx;
        }
        const gutter = i === 0 ? g.gutterCorner : g.gutterBar;
        const sum = counts.get(i);
        return (
          <Text key={i} color={color} backgroundColor={bg} wrap="wrap" bold={bold}>
            {gutter} {line}
            {sum && (
              <>
                {'  '}
                <Text color={theme.accents.success} bold>{`+${sum.added}`}</Text>
                {' '}
                <Text color={theme.accents.error} bold>{`-${sum.removed}`}</Text>
              </>
            )}
          </Text>
        );
      })}
    </Box>
  );
}

function diffLineStyle(trimmed: string, theme: DayaTheme, forced?: string): { color: string; bold: boolean } {
  if (forced) return { color: forced, bold: false };
  let color = theme.text.muted;
  let bold = false;
  if (trimmed.startsWith('@@')) {
    color = theme.accents.info;
    bold = true;
  } else if (trimmed.startsWith('diff --git') || trimmed.startsWith('index ') || trimmed.startsWith('+++') || trimmed.startsWith('---')) {
    color = theme.accents.warning;
  } else if (trimmed.startsWith('+') && !trimmed.startsWith('+ git')) {
    color = theme.accents.success;
  } else if (trimmed.startsWith('-') && !trimmed.startsWith('- git')) {
    color = theme.accents.error;
  }
  return { color, bold };
}

function ChangeDiff({ change, theme, columns }: { change: EditReviewChange; theme: DayaTheme; columns: number }): React.ReactElement {
  const g = glyphs();
  const oldLines = (change.old_text ?? '').split('\n');
  const newLines = change.new_text.split('\n');
  const max = Math.max(oldLines.length, newLines.length);
  // Sequential fallback for very large hunks so the columns stay usable.
  if (max > 60) return <DiffMeta text={formatChangeDiff(change)} theme={theme} />;
  const half = Math.max(16, Math.floor((columns - 4) / 2));
  const numWidth = Math.max(3, String(max).length);
  const pad = (n: number) => String(n).padStart(numWidth, ' ');
  return (
    <Box flexDirection="column">
      <Box width={columns - 2}>
        <Box width={numWidth + 1} />
        <Box width={half}>
          <Text color={theme.text.muted}>- before</Text>
        </Box>
        <Box width={numWidth + 1} />
        <Box width={half}>
          <Text color={theme.text.muted}>+ after</Text>
        </Box>
      </Box>
      {Array.from({ length: max }, (_, i) => {
        const o = oldLines[i] ?? '';
        const n = newLines[i] ?? '';
        const ln = i + 1;
        return (
          <Box key={i} flexDirection="row">
            <Box width={numWidth + 1}>
              <Text color={theme.text.muted}>{pad(ln)}</Text>
            </Box>
            <Box width={half}>
              <Text color={theme.accents.error} wrap="truncate">{o ? `- ${o}` : ' '}</Text>
            </Box>
            <Box width={numWidth + 1}>
              <Text color={theme.text.muted}>{pad(ln)}</Text>
            </Box>
            <Box width={half}>
              <Text color={theme.accents.success} wrap="truncate">{n ? `+ ${n}` : ' '}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

interface InlineSeg {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

function parseInline(text: string): InlineSeg[] {
  const out: InlineSeg[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) out.push({ text: m[2], italic: true });
    else out.push({ text: m[3]!, code: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function InlineText({ text, base, theme }: { text: string; base: string; theme: DayaTheme }): React.ReactElement {
  return (
    <Text color={base} wrap="wrap">
      {parseInline(text).map((s, i) => (
        <Text key={i} color={s.code ? theme.accents.info : base} bold={s.bold} italic={s.italic}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** Lightweight markdown renderer for assistant replies (no extra deps). */
function MarkdownLines({ text, theme }: { text: string; theme: DayaTheme }): React.ReactElement {
  const g = glyphs();
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const lines = text.split('\n');
  const rows: React.ReactNode[] = [];
  let code: string[] | null = null;
  const pushCode = (): void => {
    if (code !== null) {
      if (code.length > 0) {
        rows.push(
          <Box key={`code-${rows.length}`} flexDirection="column">
            {code.map((l, i) => (
              <Text key={i} color={theme.text.secondary} wrap="wrap">{l}</Text>
            ))}
          </Box>,
        );
      } else {
        rows.push(<Text key={`code-${rows.length}`} color={theme.text.muted}>```</Text>);
      }
      code = null;
    }
  };
  for (const raw of lines) {
    const ln = raw.trimEnd();
    if (/^ {0,3}```/.test(ln)) {
      if (code) pushCode();
      else code = [];
      continue;
    }
    if (code) {
      code.push(ln);
      continue;
    }
    if (!ln.trim()) continue;

    const h = /^ {0,3}(#{1,6})\s+(.*)$/.exec(ln);
    if (h) {
      rows.push(
        <Text key={`h-${rows.length}`} color={theme.accents.info} bold wrap="wrap">
          {h[2]!}
        </Text>,
      );
      continue;
    }
    if (/^ {0,3}([-*_])(\s*\1\s*){1,}$/.test(ln) || /^ {0,3}-{3,}\s*$/.test(ln)) {
      rows.push(
        <Text key={`hr-${rows.length}`} color={theme.text.muted}>
          {g.hairline.repeat(Math.max(8, columns - 4))}
        </Text>,
      );
      continue;
    }
    const cb = /^ {0,3}[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(ln);
    if (cb) {
      const done = cb[1]!.toLowerCase() === 'x';
      rows.push(
        <Box key={`cb-${rows.length}`}>
          <Text color={done ? theme.accents.success : theme.text.muted}>{done ? g.check : g.planDot} </Text>
          <InlineText text={cb[2]!} base={done ? theme.text.secondary : theme.text.primary} theme={theme} />
        </Box>,
      );
      continue;
    }
    const bl = /^ {0,3}[-*+]\s+(.*)$/.exec(ln);
    if (bl) {
      rows.push(
        <Box key={`bl-${rows.length}`}>
          <Text color={theme.text.secondary}>{g.bullet} </Text>
          <InlineText text={bl[1]!} base={theme.text.primary} theme={theme} />
        </Box>,
      );
      continue;
    }
    const nl = /^ {0,3}(\d+)[.)]\s+(.*)$/.exec(ln);
    if (nl) {
      rows.push(
        <Box key={`nl-${rows.length}`}>
          <Text color={theme.text.secondary}>{nl[1]}.</Text>
          <InlineText text={` ${nl[2]!}`} base={theme.text.primary} theme={theme} />
        </Box>,
      );
      continue;
    }
    const bq = /^ {0,3}>\s?(.*)$/.exec(ln);
    if (bq) {
      rows.push(
        <Box key={`bq-${rows.length}`}>
          <Text color={theme.text.muted}>{g.gutterBar} </Text>
          <InlineText text={bq[1]!} base={theme.text.secondary} theme={theme} />
        </Box>,
      );
      continue;
    }
    rows.push(<InlineText key={`p-${rows.length}`} text={ln} base={theme.text.primary} theme={theme} />);
  }
  pushCode();
  return <Box flexDirection="column">{rows}</Box>;
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

function formatChangeDiff(change: EditReviewChange): string {
  const oldLines = (change.old_text ?? '').split('\n');
  const newLines = change.new_text.split('\n');
  const max = Math.max(oldLines.length, newLines.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    if (i < oldLines.length) out.push(`-${oldLines[i]}`);
    if (i < newLines.length) out.push(`+${newLines[i]}`);
  }
  return out.join('\n');
}

export function upsertAssistant(logs: LogEntry[], text: string): LogEntry[] {
  const g = glyphs();
  const caretText = `${text}${g.caret}`;
  const idx = [...logs].reverse().findIndex((l) => l.kind === 'assistant' && l.meta === 'streaming');
  if (idx === -1) {
    return [...logs, { kind: 'assistant', text: caretText, meta: 'streaming' }];
  }
  const realIdx = logs.length - 1 - idx;
  const next = [...logs];
  const existing = next[realIdx];
  if (existing) {
    next[realIdx] = { ...existing, text: caretText };
  }
  return next;
}

export function finalizeStreaming(logs: LogEntry[]): LogEntry[] {
  return logs.map((l) =>
    l.kind === 'assistant' && l.meta === 'streaming'
      ? { ...l, text: l.text.replace(/[▍|]$/, ''), meta: undefined }
      : l,
  );
}

export const MAX_TOOL_LINES = 30;

export function truncateOutput(output: string): string {
  const lines = output.split('\n');
  if (lines.length <= MAX_TOOL_LINES) return output;
  const extra = lines.length - MAX_TOOL_LINES;
  return `${lines.slice(0, MAX_TOOL_LINES).join('\n')}\n… ${extra} more ${extra === 1 ? 'line' : 'lines'}`;
}

export function truncateDiff(diff: string, maxLines: number): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  return `${lines.slice(0, maxLines).join('\n')}\n… ${lines.length - maxLines} more ${lines.length - maxLines === 1 ? 'line' : 'lines'}`;
}