import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent/loop.js';
import { defaultTools } from '../src/tools/index.js';
import { AllowAllChecker } from '../src/permissions/checker.js';
import type { Provider, ProviderEvent, ProviderStreamParams, Message, ToolCall } from '../src/types.js';

/**
 * Scripted provider that first asks to edit a file with an old_string that is
 * absent (so the edit fails), then on the next model call (after the
 * self-correction feedback) returns successfully.
 */
class SelfCorrectProvider implements Provider {
  readonly name = 'self-correct';
  readonly model = 'sc-v1';
  private calls = 0;

  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      const toolCall: ToolCall = {
        id: 'tc-1',
        name: 'edit_file',
        input: { path: 'a.txt', old_string: 'does-not-exist', new_string: 'x' },
      };
      yield { type: 'tool_use', toolCall };
      yield { type: 'done', reason: 'tool_use' };
      return;
    }
    // Second call: the feedback message must be present.
    const hasFeedback = params.messages.some(
      (m) => m.role === 'system' && m.content.includes('self-correction'),
    );
    yield { type: 'text_delta', delta: hasFeedback ? 'fixed' : 'missing feedback' };
    yield { type: 'done', reason: 'end_turn' };
  }
}

describe('Agent self-correction', () => {
  it('feeds tool failures back and lets the model retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daya-selfcorr-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'hello', 'utf8');

    const provider = new SelfCorrectProvider();
    const events: string[] = [];
    const agent = new Agent({
      provider,
      tools: defaultTools(),
      permissions: new AllowAllChecker(),
      cwd: dir,
      maxSteps: 4,
      maxSelfCorrections: 2,
    });

    const messages = await agent.run('fix the file', {
      onEvent: (e) => events.push(e.type),
    });
    const texts = messages.map((m) => m.content).join(' ');

    expect(events).toContain('self_correct');
    expect(texts).toContain('fixed');
    expect(texts).toContain('self-correction');
    expect(provider.calls).toBeGreaterThanOrEqual(2);

    rmSync(dir, { recursive: true, force: true });
  });
});
