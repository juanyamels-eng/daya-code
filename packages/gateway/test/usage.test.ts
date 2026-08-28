import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore, type UsageRecord } from '../src/usage.js';

let dir: string;
let file: string;

function rec(partial: Partial<UsageRecord> & { token: string }): UsageRecord {
  return {
    token: partial.token,
    name: 'u',
    model: 'm',
    upstream: 'openai',
    promptTokens: 100,
    completionTokens: 50,
    costUsd: 0.001,
    ts: Date.now(),
    ...partial,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daya-usage-'));
  file = join(dir, 'usage.jsonl');
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('UsageStore', () => {
  it('tracks totals in memory immediately', async () => {
    const s = new UsageStore(file);
    s.record(rec({ token: 't1' }));
    s.record(rec({ token: 't1' }));
    expect(s.monthTokens('t1')).toBe(300);
    expect(s.userStats('t1').requests).toBe(2);
    expect(s.monthTokens('t2')).toBe(0);
    await s.flush();
  });

  it('persists asynchronously and survive a "restart" via flush', async () => {
    const s = new UsageStore(file);
    s.record(rec({ token: 't1', promptTokens: 100, completionTokens: 100 }));
    s.record(rec({ token: 't2', promptTokens: 5, completionTokens: 5 }));
    await s.flush();
    expect(existsSync(file)).toBe(true);

    const reloaded = new UsageStore(file);
    expect(reloaded.monthTokens('t1')).toBe(200);
    expect(reloaded.monthTokens('t2')).toBe(10);
  });
});