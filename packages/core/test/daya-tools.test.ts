import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DayaClient, DayaHttpError, type GenerateImageResponse, type WebSearchResponse, type DocumentsQueryResponse, type MemoryQueryResponse } from '../src/daya/client.js';
import { generateImage, webSearch, documentsQuery, memoryStore, memoryRecall } from '../src/tools/daya/index.js';
import { LocalMemory } from '../src/dayamemory/local.js';
import type { ToolContext } from '../src/types.js';
import { AllowAllChecker } from '../src/permissions/checker.js';

function makeFetch(responses: Array<{ match: (url: string, init?: RequestInit) => boolean; status: number; body: unknown }>): typeof fetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init });
    for (const r of responses) {
      if (r.match(u, init)) {
        return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
      }
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  (fn as unknown as { __calls: typeof calls }).__calls = calls;
  return fn;
}

function ctxWith(client: DayaClient | null, mem: LocalMemory | null, cwd: string): ToolContext {
  const c: ToolContext = {
    cwd,
    signal: new AbortController().signal,
    permissions: new AllowAllChecker(),
  };
  if (client) (c as ToolContext & { dayaClient?: DayaClient }).dayaClient = client;
  if (mem) (c as ToolContext & { memory?: LocalMemory }).memory = mem;
  return c;
}

describe('DayaClient', () => {
  it('builds url, auth header and parses JSON', async () => {
    const fetchImpl = makeFetch([{ match: () => true, status: 200, body: { ok: true, n: 1 } }]);
    const c = new DayaClient({ baseUrl: 'https://api.daya.ai/', apiKey: 'daya-test', fetchImpl });
    const r = await c.request<{ ok: boolean; n: number }>('POST', '/v1/test', { a: 1 });
    expect(r.ok).toBe(true);
    const calls = (fetchImpl as unknown as { __calls: Array<{ url: string; init?: RequestInit }> }).__calls;
    expect(calls[0]?.url).toBe('https://api.daya.ai/v1/test');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer daya-test');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('strips trailing slash from baseUrl', async () => {
    const fetchImpl = makeFetch([{ match: () => true, status: 200, body: { ok: true } }]);
    const c = new DayaClient({ baseUrl: 'https://api.daya.ai///', apiKey: 'k', fetchImpl });
    await c.request('GET', '/x');
    const calls = (fetchImpl as unknown as { __calls: Array<{ url: string }> }).__calls;
    expect(calls[0]?.url).toBe('https://api.daya.ai/x');
  });

  it('throws DayaHttpError on non-2xx', async () => {
    const fetchImpl = makeFetch([{ match: () => true, status: 401, body: { error: 'unauthorized' } }]);
    const c = new DayaClient({ baseUrl: 'https://x', apiKey: 'bad', fetchImpl });
    await expect(c.request('GET', '/me')).rejects.toBeInstanceOf(DayaHttpError);
  });
});

describe('daya_generate_image tool', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daya-img-'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns error when client missing', async () => {
    const r = await generateImage({ prompt: 'a cat' }, ctxWith(null, null, dir));
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/DAYA_API_KEY/);
  });

  it('saves image to disk when savePath provided', async () => {
    const img: GenerateImageResponse = {
      created: 1,
      data: [{ url: 'https://cdn.daya.ai/x.png', revised_prompt: 'a cat' }],
    };
    const fetchImpl = makeFetch([
      { match: (u) => u.includes('/v1/images/generations'), status: 200, body: img },
      { match: (u) => u.includes('cdn.daya.ai'), status: 200, body: 'PNGDATA' },
    ]);
    const client = new DayaClient({ baseUrl: 'https://api.daya.ai', apiKey: 'k', fetchImpl });
    const r = await generateImage({ prompt: 'a cat', savePath: join(dir, 'cat.png') }, ctxWith(client, null, dir));
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain('saved=');
  });
});

describe('daya_web_search tool', () => {
  it('formats results as text', async () => {
    const body: WebSearchResponse = {
      query: 'q',
      results: [
        { title: 'A', url: 'https://a', snippet: 'alpha' },
        { title: 'B', url: 'https://b', snippet: 'beta' },
      ],
    };
    const fetchImpl = makeFetch([{ match: (u) => u.includes('/v1/search'), status: 200, body }]);
    const client = new DayaClient({ baseUrl: 'https://api.daya.ai', apiKey: 'k', fetchImpl });
    const r = await webSearch({ query: 'q' }, ctxWith(client, null, process.cwd()));
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain('#1 A');
    expect(r.output).toContain('https://a');
  });

  it('says "No results." on empty', async () => {
    const fetchImpl = makeFetch([{ match: () => true, status: 200, body: { query: 'q', results: [] } }]);
    const client = new DayaClient({ baseUrl: 'https://x', apiKey: 'k', fetchImpl });
    const r = await webSearch({ query: 'q' }, ctxWith(client, null, process.cwd()));
    expect(r.output).toBe('No results.');
  });
});

describe('daya_documents_query tool', () => {
  it('formats hits', async () => {
    const body: DocumentsQueryResponse = {
      results: [
        { id: 'd1', title: 'Doc 1', content: 'hello world', score: 0.91, source: 'kb' },
      ],
    };
    const fetchImpl = makeFetch([{ match: (u) => u.includes('/v1/documents'), status: 200, body }]);
    const client = new DayaClient({ baseUrl: 'https://x', apiKey: 'k', fetchImpl });
    const r = await documentsQuery({ query: 'q' }, ctxWith(client, null, process.cwd()));
    expect(r.output).toContain('Doc 1');
    expect(r.output).toContain('score=0.910');
  });
});

describe('daya_memory_store + memory_recall', () => {
  let dir: string;
  let mem: LocalMemory;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daya-mem2-'));
    mem = new LocalMemory({ path: join(dir, 'm.db') });
  });
  afterEach(() => {
    try { mem?.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('stores and recalls locally without remote client', async () => {
    const ctx = ctxWith(null, mem, dir);
    const ns = 'ns';

    const s1 = await memoryStore({ key: 'pm', value: 'package manager is pnpm', namespace: ns }, ctx);
    expect(s1.isError).toBeFalsy();

    const r1 = await memoryRecall({ query: 'package manager', namespace: ns }, ctx);
    expect(r1.output).toContain('pm');
  });

  it('fails with sync=true when no remote client', async () => {
    const ctx = ctxWith(null, mem, dir);
    const r = await memoryStore({ key: 'x', value: 'y', sync: true }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/DAYA_API_KEY/);
  });

  it('merges local and remote recall results', async () => {
    await mem.upsert({ namespace: 'ns', key: 'local_only', value: 'stored locally in db', metadata: null, expiresAt: null });
    const remoteBody: MemoryQueryResponse = {
      results: [{ key: 'remote_only', value: 'from remote', score: 0.1 }],
    };
    const fetchImpl = makeFetch([{ match: (u) => u.includes('/v1/memory/query'), status: 200, body: remoteBody }]);
    const client = new DayaClient({ baseUrl: 'https://x', apiKey: 'k', fetchImpl });
    const ctx = ctxWith(client, mem, dir);
    const r = await memoryRecall({ query: 'local', namespace: 'ns', include_remote: true }, ctx);
    expect(r.output).toContain('local_only');
    expect(r.output).toContain('remote_only');
  });
});
