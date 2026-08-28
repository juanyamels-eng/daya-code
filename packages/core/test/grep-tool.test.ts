import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepContent } from '../src/tools/grep.js';
import type { ToolContext } from '../src/types.js';
import { AllowAllChecker } from '../src/permissions/checker.js';

let dir: string;

function ctx(): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, permissions: new AllowAllChecker() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daya-grep-'));
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('grepContent', () => {
  it('returns file:line:content matches', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello\nworld\n', 'utf8');
    writeFileSync(join(dir, 'b.txt'), 'nope\n', 'utf8');
    const r = await grepContent({ pattern: 'world' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain(`a.txt:2:world`);
  });

  it('honors maxResults and stops walking early', async () => {
    mkdirSync(join(dir, 'sub1'));
    mkdirSync(join(dir, 'sub2'));
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, 'sub1', `f${i}.txt`), `needle-${i}\n`, 'utf8');
    }
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, 'sub2', `g${i}.txt`), `needle-${i}-sub2\n`, 'utf8');
    }
    const r = await grepContent({ pattern: 'needle', maxResults: 3 }, ctx());
    expect(r.isError).toBeFalsy();
    expect((r as { metadata?: { count?: number } }).metadata?.count).toBe(3);
    expect(r.output).toContain('needle-0');
    expect(r.output).toContain('needle-2');
    expect(r.output).not.toContain('sub2');
  });

  it('skips binary files', async () => {
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03]));
    writeFileSync(join(dir, 'text.txt'), 'alpha beta\n', 'utf8');
    const r = await grepContent({ pattern: 'alpha' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain('text.txt:1:alpha beta');
  });
});