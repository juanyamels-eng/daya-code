import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import {
  Agent,
  defaultTools,
  AllowAllChecker,
  createProvider,
  SessionStore,
  type AgentEvent,
  type Message,
  type Provider,
  type ProviderName,
} from '@daya-code/core';

export interface AppProps {
  initialPrompt: string;
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  cwd: string;
  sessionsDir?: string;
}

interface LogEntry {
  kind: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  meta?: string;
}

function makeProvider(p: AppProps): Provider {
  return createProvider({ name: p.provider, model: p.model, apiKey: p.apiKey, baseUrl: p.baseUrl });
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      kind: 'system',
      text: `DAYA Code v0.2.0 — provider=${props.provider} model=${props.model} cwd=${props.cwd}`,
    },
    {
      kind: 'system',
      text: 'Type a message and press Enter. /quit /clear /model /sessions for help.',
    },
  ]);
  const [busy, setBusy] = useState(false);
  const agentRef = useRef<Agent>();
  const propsRef = useRef(props);
  propsRef.current = props;
  const messagesRef = useRef<Message[]>([]);
  const abortRef = useRef<AbortController>();
  const sessionRef = useRef<string | null>(null);
  const storeRef = useRef<SessionStore | null>(null);

  useEffect(() => {
    const store = props.sessionsDir ? new SessionStore(props.sessionsDir) : null;
    storeRef.current = store;

    agentRef.current = new Agent({
      provider: makeProvider(props),
      tools: defaultTools(),
      permissions: new AllowAllChecker(),
      cwd: props.cwd,
    });

    // Auto-create session
    if (store) {
      store.init().then(async () => {
        const session = await store.create(props.cwd);
        sessionRef.current = session.meta.id;
      });
    }
  }, [props.provider, props.model, props.apiKey, props.baseUrl, props.cwd, props.sessionsDir]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
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

  const onSubmit = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    setInput('');
    if (!trimmed) return;

    if (trimmed === '/quit') {
      await saveSession();
      exit();
      return;
    }

    if (trimmed === '/clear') {
      setLogs([{ kind: 'system', text: 'Session cleared.' }]);
      messagesRef.current = [];
      await saveSession();
      return;
    }

    if (trimmed === '/sessions') {
      const store = storeRef.current;
      if (!store) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'Session persistence not configured.' }]);
        return;
      }
      const list = await store.list();
      if (list.length === 0) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'No saved sessions.' }]);
      } else {
        const lines = list.map((s) => `  ${s.id} — ${new Date(s.updatedAt).toLocaleString()} — ${s.title ?? '(untitled)'}`);
        setLogs((prev) => [...prev, { kind: 'system', text: `Saved sessions:\n${lines.join('\n')}` }]);
      }
      return;
    }

    if (trimmed.startsWith('/model ')) {
      const next = trimmed.slice('/model '.length).trim();
      if (!next) {
        setLogs((prev) => [...prev, { kind: 'system', text: 'usage: /model <model-id>' }]);
        return;
      }
      propsRef.current = { ...propsRef.current, model: next };
      agentRef.current = new Agent({
        provider: makeProvider(propsRef.current),
        tools: defaultTools(),
        permissions: new AllowAllChecker(),
        cwd: propsRef.current.cwd,
      });
      setLogs((prev) => [...prev, { kind: 'system', text: `switched to model=${next}` }]);
      return;
    }

    setLogs((prev) => [...prev, { kind: 'user', text: trimmed }]);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let assistantBuffer = '';

    try {
      await agentRef.current!.run(trimmed, {
        signal: ctrl.signal,
        history: messagesRef.current,
        onEvent: (ev: AgentEvent) => {
          switch (ev.type) {
            case 'assistant_text_delta': {
              assistantBuffer += (ev.data as { delta: string }).delta;
              setLogs((prev) => upsertAssistant(prev, assistantBuffer));
              break;
            }
            case 'tool_started': {
              const { name, input } = ev.data as { name: string; input: unknown };
              setLogs((prev) => [
                ...prev,
                { kind: 'tool', text: `\u25b6 ${name}`, meta: JSON.stringify(input) },
              ]);
              break;
            }
            case 'tool_finished': {
              const { name, result } = ev.data as { name: string; result: { output: string; isError?: boolean } };
              setLogs((prev) => [
                ...prev,
                {
                  kind: 'tool',
                  text: result.isError ? `\u2716 ${name} error` : `\u2713 ${name}`,
                  meta: result.output,
                },
              ]);
              break;
            }
            case 'compacted': {
              const { removed, kept } = ev.data as { removed: number; kept: number };
              setLogs((prev) => [
                ...prev,
                { kind: 'system', text: `Context compacted: summarized ${removed} messages, kept ${kept} recent.` },
              ]);
              break;
            }
            case 'done': {
              messagesRef.current = (ev.data as { messages: Message[] }).messages;
              break;
            }
            case 'error': {
              setLogs((prev) => [...prev, { kind: 'system', text: `error: ${String(ev.data)}` }]);
              break;
            }
            default:
              break;
          }
        },
      });
    } catch (e) {
      setLogs((prev) => [...prev, { kind: 'system', text: `error: ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setBusy(false);
      await saveSession();
    }
  };

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        {logs.map((entry, i) => (
          <Box key={i} flexDirection="column">
            <Text color={colorFor(entry.kind)}>{prefixFor(entry.kind)}</Text>
            <Text wrap="wrap">{entry.text}</Text>
            {entry.meta && (
              <Text color="gray" wrap="wrap">
                {'  '}\u2514 {entry.meta}
              </Text>
            )}
          </Box>
        ))}
        {busy && (
          <Box marginTop={1}>
            <Text color="yellow">
              <Spinner type="dots" /> thinking...
            </Text>
          </Box>
        )}
      </Box>
      <Box>
        <Text color="green">daya \u276f </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder={busy ? '(busy, wait...)' : 'Type your request...'}
        />
      </Box>
    </Box>
  );
}

function prefixFor(kind: LogEntry['kind']): string {
  switch (kind) {
    case 'user':
      return '\u25b8 you';
    case 'assistant':
      return '\u25c6 daya';
    case 'tool':
      return '\u2699 tool';
    case 'system':
      return '\u00b7 sys';
  }
}

function colorFor(kind: LogEntry['kind']): string {
  switch (kind) {
    case 'user':
      return 'cyan';
    case 'assistant':
      return 'magenta';
    case 'tool':
      return 'yellow';
    case 'system':
      return 'gray';
  }
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
