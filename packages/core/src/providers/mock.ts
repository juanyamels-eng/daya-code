import { nanoid } from 'nanoid';
import type { Provider, ProviderEvent, ProviderStreamParams } from '../types.js';

/**
 * MockProvider echoes the user message and, on the first turn, also emits a
 * single bash tool call to demonstrate the agent loop. On subsequent turns
 * (after the bash tool result has been appended), it simply responds with a
 * summary and ends the turn so the loop terminates.
 */
export class MockProvider implements Provider {
  readonly name = 'mock';
  readonly model = 'mock-echo-v1';

  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    const hasToolResult = params.messages.some((m) => m.role === 'tool');
    const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
    const echo = lastUser ? `DAYA Code (mock): you said — "${lastUser.content}"` : 'No user message.';

    const words = echo.split(' ');
    for (const word of words) {
      yield { type: 'text_delta', delta: word + ' ' };
      await sleep(20);
    }

    if (!hasToolResult && params.tools.some((t) => t.name === 'bash')) {
      yield {
        type: 'tool_use',
        toolCall: {
          id: nanoid(),
          name: 'bash',
          input: { command: 'echo hello from daya-code mock agent' },
        },
      };
      yield { type: 'done', reason: 'tool_use' };
      return;
    }

    const summary = hasToolResult
      ? 'Tool executed successfully. The mock agent has nothing more to do.'
      : 'No tools available; ending turn.';
    for (const word of summary.split(' ')) {
      yield { type: 'text_delta', delta: word + ' ' };
      await sleep(20);
    }
    yield { type: 'done', reason: 'end_turn' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
