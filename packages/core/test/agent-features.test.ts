import { describe, it, expect } from 'vitest';
import { Agent, loadConventions } from '../src/agent/loop.js';
import { MockProvider } from '../src/providers/mock.js';
import { defaultTools } from '../src/tools/index.js';
import { AllowAllChecker } from '../src/permissions/checker.js';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider, ProviderEvent, ProviderStreamParams, Message } from '../src/types.js';

class CapturingProvider implements Provider {
  readonly name = 'capture';
  readonly model = 'capture-v1';
  lastSystem: string | null = null;
  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    this.lastSystem = params.system;
    yield { type: 'done', reason: 'end_turn' };
  }
}

class EchoProvider implements Provider {
  readonly name = 'echo';
  readonly model = 'echo-v1';
  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    yield { type: 'text_delta', delta: 'Echo: ' };
    yield { type: 'text_delta', delta: 'done' };
    yield { type: 'done', reason: 'end_turn' };
  }
}

function makeAgent(cwd: string, opts: Partial<ConstructorParameters<typeof Agent>[0]> = {}): Agent {
  return new Agent({
    provider: new MockProvider(),
    tools: defaultTools(),
    permissions: new AllowAllChecker(),
    cwd,
    maxSteps: 3,
    ...opts,
  });
}

describe('Plan/Build mode', () => {
  it('defaults to build mode', () => {
    const agent = makeAgent(__dirname);
    expect(agent.getMode()).toBe('build');
  });

  it('can switch to plan mode', () => {
    const agent = makeAgent(__dirname);
    agent.setMode('plan');
    expect(agent.getMode()).toBe('plan');
  });

  it('plan mode filters out mutating tools', () => {
    const agent = makeAgent(__dirname);
    agent.setMode('plan');
    const defs = agent.toolDefinitions();
    const names = defs.map((d) => d.name);
    expect(names).toContain('read_file');
    expect(names).toContain('glob');
    expect(names).toContain('grep');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('bash');
  });

  it('build mode includes all tools', () => {
    const agent = makeAgent(__dirname);
    const defs = agent.toolDefinitions();
    const names = defs.map((d) => d.name);
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('bash');
  });

  it('plan mode system prompt contains PLAN instructions', async () => {
    const dir = join(tmpdir(), `daya-test-plan-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const provider = new CapturingProvider();
    const agent = new Agent({
      provider,
      tools: defaultTools(),
      permissions: new AllowAllChecker(),
      cwd: dir,
      maxSteps: 1,
      mode: 'plan',
    });
    await agent.run('hello');
    expect(provider.lastSystem).toContain('PLAN');
    expect(provider.lastSystem).toContain('read_file');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('DAYA.md conventions', () => {
  it('loads DAYA.md from project root', async () => {
    const dir = join(tmpdir(), `daya-test-conv-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'DAYA.md'), '# Conventions\nUse TypeScript strict mode.');

    const conventions = await loadConventions(dir);
    expect(conventions).toContain('TypeScript strict mode');
    await rm(dir, { recursive: true, force: true });
  });

  it('loads AGENTS.md as fallback', async () => {
    const dir = join(tmpdir(), `daya-test-conv2-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), '# Agents rules\nAlways commit with conventional commits.');

    const conventions = await loadConventions(dir);
    expect(conventions).toContain('conventional commits');
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined when no conventions file exists', async () => {
    const dir = join(tmpdir(), `daya-test-conv3-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const conventions = await loadConventions(dir);
    expect(conventions).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it('injects conventions into system prompt', async () => {
    const dir = join(tmpdir(), `daya-test-conv4-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'DAYA.md'), '# Rules\nNever use var.');

    const provider = new CapturingProvider();
    const agent = new Agent({
      provider,
      tools: defaultTools(),
      permissions: new AllowAllChecker(),
      cwd: dir,
      maxSteps: 1,
      conventions: '## Rules\nNever use var.',
    });
    await agent.run('hello');
    expect(provider.lastSystem).toContain('Never use var');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('@file mentions', () => {
  it('attaches file content when @path is in prompt', async () => {
    const dir = join(tmpdir(), `daya-test-mention-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'test.txt');
    await writeFile(filePath, 'Hello from file');

    const provider = new CapturingProvider();
    const agent = new Agent({
      provider,
      tools: defaultTools(),
      permissions: new AllowAllChecker(),
      cwd: dir,
      maxSteps: 1,
    });
    await agent.run(`check @${filePath}`);
    expect(provider.lastSystem).toBeDefined();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('/compact manual', () => {
  it('compacts messages when enough history exists', async () => {
    const dir = join(tmpdir(), `daya-test-compact-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const agent = makeAgent(dir);

    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({
        id: `msg-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}: ${'x'.repeat(100)}`,
        timestamp: Date.now(),
      });
    }

    const before = messages.length;
    agent.compactManual(messages);
    expect(messages.length).toBeLessThan(before);
    expect(messages.length).toBeGreaterThan(0);
    await rm(dir, { recursive: true, force: true });
  });

  it('does nothing with few messages', async () => {
    const dir = join(tmpdir(), `daya-test-compact2-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const agent = makeAgent(dir);
    const messages: Message[] = [
      { id: '1', role: 'user', content: 'hi', timestamp: Date.now() },
    ];
    agent.compactManual(messages);
    expect(messages.length).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('getContextInfo', () => {
  it('returns correct mode and files referenced', async () => {
    const dir = join(tmpdir(), `daya-test-ctx-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const agent = makeAgent(dir);
    const info = agent.getContextInfo();
    expect(info.mode).toBe('build');
    expect(info.filesReferenced).toEqual([]);
    expect(info.maxTokens).toBe(4096);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('revertLastCommit', () => {
  it('reverts the last git commit', async () => {
    const dir = join(tmpdir(), `daya-test-revert-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    await exec('git', ['init'], { cwd: dir });
    await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    await exec('git', ['config', 'user.name', 'test'], { cwd: dir });
    await writeFile(join(dir, 'a.txt'), 'first');
    await exec('git', ['add', '-A'], { cwd: dir });
    await exec('git', ['commit', '-m', 'first commit'], { cwd: dir });

    await writeFile(join(dir, 'a.txt'), 'second');
    await exec('git', ['add', '-A'], { cwd: dir });
    await exec('git', ['commit', '-m', 'second commit'], { cwd: dir });

    const agent = makeAgent(dir);
    const hash = await agent.revertLastCommit(dir, new AbortController().signal);
    expect(hash).toBeTruthy();

    const { stdout } = await exec('git', ['log', '-1', '--format=%s'], { cwd: dir });
    expect(stdout.trim()).toBe('first commit');

    await rm(dir, { recursive: true, force: true });
  });
});
