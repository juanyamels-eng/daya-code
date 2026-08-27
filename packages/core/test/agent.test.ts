import { describe, it, expect } from 'vitest';
import { Agent } from '../src/agent/loop.js';
import { MockProvider } from '../src/providers/mock.js';
import { defaultTools } from '../src/tools/index.js';
import { AllowAllChecker } from '../src/permissions/checker.js';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeAgent(cwd: string): Promise<Agent> {
  return new Agent({
    provider: new MockProvider(),
    tools: defaultTools(),
    permissions: new AllowAllChecker(),
    cwd,
    maxSteps: 5,
  });
}

describe('Agent loop', () => {
  it('runs user prompt and returns messages', async () => {
    const dir = join(tmpdir(), `daya-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const agent = await makeAgent(dir);
    const messages = await agent.run('hello agent');
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.role === 'user')).toBe(true);
    expect(messages.some((m) => m.role === 'assistant')).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('emits tool events for bash tool calls from mock provider', async () => {
    const dir = join(tmpdir(), `daya-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const agent = await makeAgent(dir);

    const events: string[] = [];
    await agent.run('test', {
      onEvent: (e) => events.push(e.type),
    });
    expect(events).toContain('tool_started');
    expect(events).toContain('tool_finished');
    expect(events).toContain('done');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('write_file tool', () => {
  it('writes a file successfully', async () => {
    const dir = join(tmpdir(), `daya-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const agent = await makeAgent(dir);
    const tools = defaultTools();
    const write = tools.find((t) => t.definition.name === 'write_file')!;
    const res = await write.execute(
      { path: join(dir, 'hello.txt'), content: 'hi from test' },
      { cwd: dir, signal: new AbortController().signal, permissions: new AllowAllChecker() },
    );
    expect(res.isError).toBeFalsy();
    const written = await readFile(join(dir, 'hello.txt'), 'utf8');
    expect(written).toBe('hi from test');
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects invalid input', async () => {
    const dir = join(tmpdir(), `daya-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const tools = defaultTools();
    const write = tools.find((t) => t.definition.name === 'write_file')!;
    const res = await write.execute(
      { path: 123 } as unknown,
      { cwd: dir, signal: new AbortController().signal, permissions: new AllowAllChecker() },
    );
    expect(res.isError).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('edit_file tool', () => {
  it('replaces single occurrence', async () => {
    const dir = join(tmpdir(), `daya-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const target = join(dir, 'a.ts');
    await writeFile(target, 'const x = 1;\nconst y = 2;\n');
    const tools = defaultTools();
    const edit = tools.find((t) => t.definition.name === 'edit_file')!;
    const res = await edit.execute(
      { path: target, old_string: 'const x = 1;', new_string: 'const x = 99;' },
      { cwd: dir, signal: new AbortController().signal, permissions: new AllowAllChecker() },
    );
    expect(res.isError).toBeFalsy();
    const after = await readFile(target, 'utf8');
    expect(after).toContain('const x = 99;');
    await rm(dir, { recursive: true, force: true });
  });

  it('fails when pattern matches multiple lines', async () => {
    const dir = join(tmpdir(), `daya-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const target = join(dir, 'a.ts');
    await writeFile(target, 'foo\nfoo\n');
    const tools = defaultTools();
    const edit = tools.find((t) => t.definition.name === 'edit_file')!;
    const res = await edit.execute(
      { path: target, old_string: 'foo', new_string: 'bar' },
      { cwd: dir, signal: new AbortController().signal, permissions: new AllowAllChecker() },
    );
    expect(res.isError).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('glob tool', () => {
  it('finds files by pattern', async () => {
    const dir = join(tmpdir(), `daya-test-${Date.now()}`);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/a.ts'), '');
    await writeFile(join(dir, 'src/b.ts'), '');
    const tools = defaultTools();
    const glob = tools.find((t) => t.definition.name === 'glob')!;
    const res = await glob.execute(
      { pattern: '**/*.ts', cwd: dir },
      { cwd: dir, signal: new AbortController().signal, permissions: new AllowAllChecker() },
    );
    expect(res.output).toContain('a.ts');
    expect(res.output).toContain('b.ts');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('grep tool', () => {
  it('finds matching lines', async () => {
    const dir = join(tmpdir(), `daya-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.ts'), 'const foo = 1;\nconst bar = 2;\n');
    const tools = defaultTools();
    const grep = tools.find((t) => t.definition.name === 'grep')!;
    const res = await grep.execute(
      { pattern: 'foo', cwd: dir },
      { cwd: dir, signal: new AbortController().signal, permissions: new AllowAllChecker() },
    );
    expect(res.output).toContain('foo');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('bash tool', () => {
  it('runs echo', async () => {
    const dir = join(tmpdir(), `daya-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const tools = defaultTools();
    const bash = tools.find((t) => t.definition.name === 'bash')!;
    const res = await bash.execute(
      { command: process.platform === 'win32' ? 'echo hello' : 'echo hello' },
      { cwd: dir, signal: new AbortController().signal, permissions: new AllowAllChecker() },
    );
    expect(res.output.toLowerCase()).toContain('hello');
    await rm(dir, { recursive: true, force: true });
  });
});
