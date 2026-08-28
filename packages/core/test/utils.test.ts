import { describe, it, expect } from 'vitest';
import {
  computeDiff,
  computeFileDiff,
  estimateCost,
  formatCost,
  buildFileTree,
  formatFileTree,
  generateCommitMessage,
} from '../src/utils.js';
import { Agent } from '../src/agent/loop.js';
import { createProvider, PROVIDER_PRESETS, PRESET_NAMES } from '../src/providers/registry.js';
import { envOverrides } from '../src/config/loader.js';
import { MockProvider } from '../src/providers/mock.js';
import { defaultTools } from '../src/tools/index.js';
import { AllowAllChecker } from '../src/permissions/checker.js';
import { SessionStore } from '../src/session/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../src/types.js';

describe('computeDiff', () => {
  it('shows added and removed lines', () => {
    const old = 'line1\nline2\nline3';
    const nu = 'line1\nline2 modified\nline3\nline4';
    const diff = computeDiff(old, nu, 'test.ts');
    expect(diff).toContain('--- a/test.ts');
    expect(diff).toContain('+++ b/test.ts');
    expect(diff).toContain('- line2');
    expect(diff).toContain('+ line2 modified');
    expect(diff).toContain('+ line4');
  });

  it('shows identical files as empty diff', () => {
    const content = 'same\ncontent';
    const diff = computeDiff(content, content, 'test.ts');
    expect(diff).toContain('--- a/test.ts');
    const bodyLines = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    const removeLines = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    expect(bodyLines.length).toBe(0);
    expect(removeLines.length).toBe(0);
  });
});

describe('computeFileDiff', () => {
  it('generates diff for existing file', async () => {
    const dir = join(tmpdir(), `daya-test-diff-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'test.txt');
    await writeFile(file, 'old content');
    const diff = await computeFileDiff(file, 'new content', dir);
    expect(diff).toContain('- old content');
    expect(diff).toContain('+ new content');
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for identical content', async () => {
    const dir = join(tmpdir(), `daya-test-diff2-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'test.txt');
    await writeFile(file, 'same');
    const diff = await computeFileDiff(file, 'same', dir);
    expect(diff).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('estimateCost', () => {
  it('returns 0 for unknown model', () => {
    expect(estimateCost('unknown-model', 1000, 500)).toBe(0);
  });

  it('calculates cost for known model', () => {
    const cost = estimateCost('gpt-4o', 100000, 50000);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(1);
  });
});

describe('formatCost', () => {
  it('formats zero', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('formats small amounts', () => {
    expect(formatCost(0.005)).toBe('<$0.01');
  });

  it('formats normal amounts', () => {
    expect(formatCost(0.15)).toBe('$0.15');
  });
});

describe('buildFileTree', () => {
  it('builds a file tree', async () => {
    const dir = join(tmpdir(), `daya-test-tree-${Date.now()}`);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/index.ts'), '');
    await writeFile(join(dir, 'package.json'), '');
    const tree = await buildFileTree(dir, 2);
    expect(tree.length).toBeGreaterThan(0);
    const names = tree.map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('package.json');
    await rm(dir, { recursive: true, force: true });
  });

  it('formats tree as string', async () => {
    const dir = join(tmpdir(), `daya-test-tree2-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), '');
    await writeFile(join(dir, 'b.txt'), '');
    const tree = await buildFileTree(dir, 1);
    const str = formatFileTree(tree);
    expect(str).toContain('a.txt');
    expect(str).toContain('b.txt');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('SessionStore search', () => {
  it('searches sessions by ID', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daya-search-'));
    const store = new SessionStore(dir);
    await store.init();
    const session = await store.create(dir, 'Test session');
    session.messages = [
      { id: '1', role: 'user', content: 'hello world', timestamp: Date.now() },
    ];
    await store.save(session);
    const results = await store.search(session.meta.id.slice(0, 5));
    expect(results.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('searches session content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daya-search2-'));
    const store = new SessionStore(dir);
    await store.init();
    const session = await store.create(dir);
    session.messages = [
      { id: '1', role: 'user', content: 'configure typescript', timestamp: Date.now() },
    ];
    await store.save(session);
    const results = await store.searchContent('typescript');
    expect(results.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('SessionStore export', () => {
  it('exports session to markdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daya-export-'));
    const store = new SessionStore(dir);
    await store.init();
    const session = await store.create(dir);
    session.messages = [
      { id: '1', role: 'user', content: 'help me', timestamp: Date.now() },
      { id: '2', role: 'assistant', content: 'I can help', timestamp: Date.now() },
      { id: '3', role: 'tool', content: 'tool output', timestamp: Date.now() },
    ];
    await store.save(session);
    const md = await store.exportMarkdown(session);
    expect(md).toContain('## You');
    expect(md).toContain('help me');
    expect(md).toContain('## DAYA');
    expect(md).toContain('I can help');
    expect(md).not.toContain('tool output');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('generateCommitMessage', () => {
  it('generates a feature commit message', () => {
    const diff = `diff --git a/src/index.ts b/src/index.ts\n+ export const newFunc = () => 42;\n`;
    const msg = generateCommitMessage(diff);
    expect(msg).toContain('feat');
  });

  it('generates a test-tagged message', () => {
    const diff = `diff --git a/test/thing.test.ts b/test/thing.test.ts\n+ it('works', () => {});\n`;
    const msg = generateCommitMessage(diff);
    expect(msg).toContain('test');
  });

  it('generates a docs message for README', () => {
    const diff = `diff --git a/README.md b/README.md\n+ # Docs\n`;
    const msg = generateCommitMessage(diff);
    expect(msg).toContain('docs');
  });
});

describe('Agent memory file', () => {
  it('saves memory to DAYA.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daya-memfile-'));
    const agent = new Agent({
      provider: new MockProvider(),
      tools: defaultTools(),
      permissions: new AllowAllChecker(),
      cwd: dir,
      maxSteps: 1,
    });
    const ok = await agent.saveMemory('package manager', 'use pnpm');
    expect(ok).toBe(true);
    const content = await readFile(join(dir, 'DAYA.md'), 'utf8');
    expect(content).toContain('package manager: use pnpm');
    rmSync(dir, { recursive: true, force: true });
  });

  it('updates existing memory entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daya-memfile2-'));
    await writeFile(join(dir, 'DAYA.md'), '# Project Memory\n\n- package manager: npm\n');
    const agent = new Agent({
      provider: new MockProvider(),
      tools: defaultTools(),
      permissions: new AllowAllChecker(),
      cwd: dir,
      maxSteps: 1,
    });
    await agent.saveMemory('package manager', 'use pnpm');
    const content = await readFile(join(dir, 'DAYA.md'), 'utf8');
    expect(content).toContain('- package manager: use pnpm');
    expect(content).not.toContain('- package manager: npm');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('checkpoint system', () => {
  it('saves and restores checkpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daya-cp-'));
    const agent = new Agent({
      provider: new MockProvider(),
      tools: defaultTools(),
      permissions: new AllowAllChecker(),
      cwd: dir,
      maxSteps: 1,
    });
    const messages: Message[] = [
      { id: '1', role: 'user', content: 'hello', timestamp: Date.now() },
    ];
    const id = await agent.saveCheckpoint('first', messages);
    expect(id).toBeTruthy();

    const cps = agent.getCheckpoints();
    expect(cps.length).toBe(1);
    expect(cps[0]!.label).toBe('first');

    const restored = await agent.restoreCheckpoint(id);
    expect(restored).not.toBeNull();
    expect(restored!.length).toBe(1);
    expect(restored![0]!.content).toBe('hello');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('openai-compatible provider', () => {
  it('creates a provider with a custom base URL and key', () => {
    const p = createProvider({
      name: 'openai-compatible',
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
    expect(p.name).toBe('openai-compatible');
    expect(p.model).toBe('gemini-2.5-flash');
  });

  it('throws a clear error when no api key is set', () => {
    expect(() => createProvider({ name: 'openai-compatible', model: 'llama3.2' })).toThrow(
      /requires an API key/,
    );
  });

  it('honors DAYA_BASE_URL env override', () => {
    const old = process.env.DAYA_BASE_URL;
    process.env.DAYA_BASE_URL = 'http://localhost:11434/v1';
    const cfg = envOverrides({
      version: 1,
      provider: { name: 'openai-compatible', model: 'llama3.2', apiKey: 'x' },
      permissions: { bash: 'prompt', write: 'prompt', edit: 'prompt' },
      sessions: { dir: 'nope' },
      mcpServers: {},
    });
    expect(cfg.provider.baseUrl).toBe('http://localhost:11434/v1');
    if (old) process.env.DAYA_BASE_URL = old;
    else delete process.env.DAYA_BASE_URL;
  });
});

describe('free provider presets', () => {
  it('exposes presets for the main free providers', () => {
    expect(PRESET_NAMES).toContain('groq');
    expect(PRESET_NAMES).toContain('gemini');
    expect(PRESET_NAMES).toContain('ollama');
    expect(PROVIDER_PRESETS['groq']!.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('creates a preset provider with its default base URL and model', () => {
    const p = createProvider({ name: 'groq', model: 'mock-echo-v1', apiKey: 'k' });
    expect(p.name).toBe('groq');
    expect(p.model).toBe('llama-3.3-70b-versatile');
  });

  it('keeps an explicit model override on a preset', () => {
    const p = createProvider({ name: 'groq', model: 'llama-4-scout-17b-16e-instruct', apiKey: 'k' });
    expect(p.model).toBe('llama-4-scout-17b-16e-instruct');
  });

  it('ollama works without an api key', () => {
    const p = createProvider({ name: 'ollama', model: 'x' });
    expect(p.name).toBe('ollama');
  });

  it('throws a clear error naming the env var when a keyed preset has no api key', () => {
    expect(() => createProvider({ name: 'groq', model: 'x' })).toThrow(/GROQ_API_KEY/);
  });

  it('allows overriding baseUrl and model on a preset', () => {
    const p = createProvider({
      name: 'openai-compatible',
      model: 'custom-model',
      apiKey: 'k',
      baseUrl: 'https://custom.example/v1',
    });
    expect(p.name).toBe('openai-compatible');
    expect(p.model).toBe('custom-model');
  });
});
