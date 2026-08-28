import { describe, it, expect } from 'vitest';
import { toCoreMessages } from '../src/providers/registry.js';
import type { Message } from '../src/types.js';

// Regression: messages sent to real providers must be valid AI SDK CoreMessages.
// The mock provider never runs this path, so the format drift went unnoticed:
// assistant parts were `tool-use`+`input` (UIMessage format) instead of
// `tool-call`+`args`, and tool results were embedded inside the assistant
// message instead of separate `role: 'tool'` messages — both rejected by
// standardizePrompt with InvalidPromptError/TypeValidationError.
describe('toCoreMessages', () => {
  const mk = (over: Partial<Message>): Message => ({
    id: 'x',
    role: 'user',
    content: '',
    timestamp: 1,
    ...over,
  });

  it('converts assistant tool calls to tool-call parts and keeps results in their own messages', () => {
    const messages: Message[] = [
      mk({ role: 'user', content: 'hi' }),
      mk({
        role: 'assistant',
        content: 'calling tools',
        toolCalls: [
          { id: 'c1', name: 'glob', input: { pattern: '**/*.ts' } },
          { id: 'c2', name: 'read_file', input: { path: 'a.ts' } },
        ],
      }),
      mk({ role: 'tool', content: 'glob output', toolCallId: 'c1' }),
      mk({ role: 'tool', content: 'file contents', toolCallId: 'c2' }),
    ];

    const out = toCoreMessages(messages);
    expect(out).toHaveLength(4);

    const assistant = out[1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant && 'content' in assistant).toBe(true);
    const parts = (assistant as { content: Record<string, unknown>[] }).content;
    expect(parts[0]).toMatchObject({ type: 'text', text: 'calling tools' });
    const calls = parts.filter((p) => p['type'] === 'tool-call');
    expect(calls[0]).toMatchObject({ type: 'tool-call', toolCallId: 'c1', toolName: 'glob', args: { pattern: '**/*.ts' } });
    expect(calls[1]).toMatchObject({ type: 'tool-call', toolCallId: 'c2', toolName: 'read_file', args: { path: 'a.ts' } });

    const t1 = out[2] as { role: string; content: Array<Record<string, unknown>> };
    expect(t1.role).toBe('tool');
    expect(t1.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'c1', toolName: 'glob', result: 'glob output' });
    const t2 = out[3] as { role: string; content: Array<Record<string, unknown>> };
    expect(t2.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'c2', toolName: 'read_file' });
  });

  it('emits an assistant content array as parts only when tool calls exist', () => {
    const messages: Message[] = [
      mk({ role: 'user', content: 'q' }),
      mk({ role: 'assistant', content: 'just text' }),
    ];
    const out = toCoreMessages(messages);
    expect(out[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'just text' }] });
  });
});