import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore, type Session } from '../src/session/store.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daya-session-'));
  store = new SessionStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sampleSession(cwd: string): Session {
  return {
    meta: { id: 'abcdefghij', createdAt: 1, updatedAt: 2, cwd },
    messages: [
      { id: 'm1', role: 'user', content: 'hello', timestamp: 3 },
      { id: 'm2', role: 'assistant', content: 'hi', timestamp: 4 },
    ],
  };
}

describe('SessionStore', () => {
  it('round-trips a session through create/get/save', async () => {
    const s = await store.create('/tmp', 'titled');
    expect(s.meta.id.length).toBeGreaterThan(0);

    const got = await store.get(s.meta.id);
    expect(got?.meta.id).toBe(s.meta.id);
    expect(got?.messages).toEqual([]);

    got!.messages = sampleSession('/tmp').messages;
    await store.save(got!);
    const again = await store.get(s.meta.id);
    expect(again?.messages.length).toBe(2);
  });

  it('returns null for an unknown session', async () => {
    expect(await store.get('nope')).toBeNull();
  });

  it('treats a corrupt/truncated session file as absent', async () => {
    writeFileSync(join(dir, 'bad.json'), '{ not valid json', 'utf8');
    expect(await store.get('bad')).toBeNull();
    // …and it must not break listing others.
    const good = await store.create('/tmp');
    const metas = await store.list();
    expect(metas.map((m) => m.id)).toEqual([good.meta.id]);
  });

  it('persists a valid file on disk (no stray temp files) after save', async () => {
    const s = await store.create('/tmp');
    s.meta.title = 'updated';
    await store.save(s);
    const parsed = JSON.parse(readFileSync(join(dir, s.meta.id + '.json'), 'utf8'));
    expect(parsed.meta.title).toBe('updated');
    // Save is atomic via rename: no leftover .tmp files in the session dir.
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});