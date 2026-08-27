import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent/loop.js';
import { MockProvider } from '../src/providers/mock.js';
import { defaultTools } from '../src/tools/index.js';
import { AllowAllChecker } from '../src/permissions/checker.js';
import { LocalMemory } from '../src/dayamemory/local.js';
import type { Provider, ProviderEvent, ProviderStreamParams, Message } from '../src/types.js';

class CapturingProvider implements Provider {
  readonly name = 'capture';
  readonly model = 'capture-v1';
  lastSystem: string | null = null;
  lastMessages: Message[] = [];
  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    this.lastSystem = params.system;
    this.lastMessages = params.messages;
    yield { type: 'done', reason: 'end_turn' };
  }
}

describe('Agent auto-recall', () => {
  it('injects relevant memories into the system prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daya-autorecall-'));
    const mem = new LocalMemory({ path: join(dir, 'm.db') });
    await mem.upsert({ namespace: dir.replace(/\\/g, '/').toLowerCase(), key: 'pm', value: 'which package manager: pnpm', metadata: null, expiresAt: null });

    const provider = new CapturingProvider();
    const agent = new Agent({
      provider,
      tools: defaultTools(),
      permissions: new AllowAllChecker(),
      cwd: dir,
      daya: { memory: mem, namespace: dir.replace(/\\/g, '/').toLowerCase(), autoRecall: true },
    });

    await agent.run('which package manager?');
    expect(provider.lastSystem).toContain('Relevant memories');
    expect(provider.lastSystem).toContain('pnpm');

    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips auto-recall when disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daya-autorecall2-'));
    const mem = new LocalMemory({ path: join(dir, 'm.db') });
    await mem.upsert({ namespace: 'whatever', key: 'pm', value: 'pnpm', metadata: null, expiresAt: null });

    const provider = new CapturingProvider();
    const agent = new Agent({
      provider,
      tools: defaultTools(),
      permissions: new AllowAllChecker(),
      cwd: dir,
      daya: { memory: mem, autoRecall: false },
    });

    await agent.run('anything');
    expect(provider.lastSystem).not.toContain('Relevant memories');

    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
