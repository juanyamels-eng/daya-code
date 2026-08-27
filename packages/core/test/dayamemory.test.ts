import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMemory } from '../src/dayamemory/local.js';

let dir: string;
let dbPath: string;
let mem: LocalMemory;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daya-mem-'));
  dbPath = join(dir, 'memory.db');
  mem = new LocalMemory({ path: dbPath });
});

afterEach(() => {
  mem.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('LocalMemory', () => {
  it('upserts and gets entries', async () => {
    const { id, updated } = await mem.upsert({ namespace: 'ns1', key: 'pm', value: 'pnpm', metadata: null, expiresAt: null });
    expect(id).toBeGreaterThan(0);
    expect(updated).toBe(false);
    const got = await mem.get('ns1', 'pm');
    expect(got?.value).toBe('pnpm');
  });

  it('updates existing key instead of duplicating', async () => {
    await mem.upsert({ namespace: 'ns1', key: 'pm', value: 'pnpm', metadata: null, expiresAt: null });
    const r = await mem.upsert({ namespace: 'ns1', key: 'pm', value: 'npm', metadata: null, expiresAt: null });
    expect(r.updated).toBe(true);
    const list = await mem.list('ns1', 10);
    expect(list).toHaveLength(1);
    expect(list[0]?.value).toBe('npm');
  });

  it('isolates namespaces', async () => {
    await mem.upsert({ namespace: 'a', key: 'x', value: '1', metadata: null, expiresAt: null });
    await mem.upsert({ namespace: 'b', key: 'x', value: '2', metadata: null, expiresAt: null });
    expect((await mem.get('a', 'x'))?.value).toBe('1');
    expect((await mem.get('b', 'x'))?.value).toBe('2');
  });

  it('query returns relevant hits (FTS5 or LIKE fallback)', async () => {
    await mem.upsert({ namespace: 'p', key: 'pm', value: 'this project uses pnpm for monorepos', metadata: null, expiresAt: null });
    await mem.upsert({ namespace: 'p', key: 'test', value: 'we use vitest for unit testing', metadata: null, expiresAt: null });
    await mem.upsert({ namespace: 'p', key: 'style', value: 'prettier with single quotes and 2 spaces', metadata: null, expiresAt: null });
    const hits = await mem.query('p', 'pnpm', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.key).toBe('pm');
  });

  it('purges expired entries', async () => {
    await mem.upsert({
      namespace: 'p',
      key: 'temp',
      value: 'short-lived',
      metadata: null,
      expiresAt: Date.now() - 1000,
    });
    await mem.upsert({ namespace: 'p', key: 'perm', value: 'permanent', metadata: null, expiresAt: null });
    await mem.purgeExpired();
    const all = await mem.list('p', 10);
    expect(all.find((h) => h.key === 'temp')).toBeUndefined();
    expect(all.find((h) => h.key === 'perm')).toBeDefined();
  });

  it('respects ttl_seconds', async () => {
    await mem.upsert({
      namespace: 'p',
      key: 'soon',
      value: 'gone',
      metadata: null,
      expiresAt: Date.now() - 1,
    });
    const purged = await mem.purgeExpired();
    expect(purged).toBe(1);
    expect(await mem.get('p', 'soon')).toBeNull();
  });

  it('delete removes an entry', async () => {
    await mem.upsert({ namespace: 'p', key: 'k', value: 'v', metadata: null, expiresAt: null });
    expect(await mem.delete('p', 'k')).toBe(true);
    expect(await mem.get('p', 'k')).toBeNull();
    expect(await mem.delete('p', 'k')).toBe(false);
  });

  it('persists across instances', async () => {
    await mem.upsert({ namespace: 'p', key: 'k', value: 'hello', metadata: null, expiresAt: null });
    mem.close();
    const reopened = new LocalMemory({ path: dbPath });
    const got = await reopened.get('p', 'k');
    expect(got?.value).toBe('hello');
    reopened.close();
  });
});
