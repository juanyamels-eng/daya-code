import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway, authenticate } from '../src/server.js';
import type { GatewayConfig } from '../src/config.js';
import type { UsageRecord } from '../src/usage.js';

function mockUpstream({ ok = true, status = 200, stream = false } = {}): { server: Server; baseUrl: string } {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const model = body.model;
      if (!ok || status >= 400) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock ${status}`, type: 'mock' } }));
        return;
      }
      const content = `hello from ${model}`;
      if (body.stream) {
        const chunksOut = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello ' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'from ' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: content.split('from ')[1] } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\n`,
          'data: [DONE]\n\n',
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const c of chunksOut) res.write(c);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock', choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
    });
  });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

let mocks: { server: Server; baseUrl: string }[] = [];
let dir = '';
let cfg: GatewayConfig;
let gw: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gateway-test-'));
  const failing = mockUpstream({ status: 429, ok: true });
  const working = mockUpstream({});
  const secondary = mockUpstream({});
  mocks = [failing, working, secondary];
  cfg = {
    port: 0,
    adminKey: 'adminkey',
    upstreams: {
      cerebras: { baseUrl: failing.baseUrl, apiKey: 'pk' },
      groq: { baseUrl: working.baseUrl, apiKey: 'gk' },
      secondary: { baseUrl: secondary.baseUrl, apiKey: 'sk' },
    },
    users: [
      { name: 'ana', token: 'tk-ana', enabled: true, quota: 100 },
      { name: 'bob', token: 'tk-bob', enabled: true },
    ],
    usageFile: join(dir, 'usage.jsonl'),
  };
  gw = createGateway(cfg);
  await new Promise<void>((resolve) => gw.listen(0, resolve));
  const { port } = gw.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => gw.close(() => resolve()));
  for (const m of mocks) await new Promise<void>((resolve) => m.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, token: string | undefined, body: unknown, stream: boolean): Promise<{ status: number; text: string }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (stream) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, text: buf.toString('utf8') };
  }
  return { status: res.status, text: await res.text() };
}

describe('gateway', () => {
  it('lists catalog models over /v1/models', async () => {
    const res = await fetch(base + '/v1/models');
    const json = (await res.json()) as { data: { id: string }[] };
    expect(res.status).toBe(200);
    expect(json.data.some((m) => m.id === 'groq-llama')).toBe(true);
    expect(json.data.some((m) => m.id === 'claude')).toBe(true);
  });

  it('rejects requests without a valid key', async () => {
    const r = await post('/v1/chat/completions', undefined, { model: 'groq-llama', messages: [{ role: 'user', content: 'hi' }] }, false);
    expect(r.status).toBe(401);
  });

  it('rejects disabled users at authentication', () => {
    const disabledCfg = { ...cfg, users: [{ name: 'zzz', token: 'tk-zzz', enabled: false }] };
    expect(authenticate(disabledCfg, 'tk-zzz')).toBeUndefined();
    expect(authenticate(disabledCfg, 'adminkey')?.admin).toBe(true);
    const dupToken = { ...cfg, users: [{ name: 'no', token: 'tk-ana', enabled: false }, { name: 'ana', token: 'tk-ana', enabled: true }] };
    expect(authenticate(dupToken, 'tk-ana')?.name).toBe('ana');
  });

  it('fails over to the secondary upstream when the primary returns 429', async () => {
    const body = {
      model: 'cerebras-llama',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    };
    const r = await post('/v1/chat/completions', 'tk-ana', body, false);
    expect(r.status).toBe(200);
    expect(r.text).toContain('hello from');
  });

  it('returns 404 for unknown models and allows raw provider/model passthrough', async () => {
    const r1 = await post('/v1/chat/completions', 'tk-ana', { model: 'nope', messages: [{ role: 'user', content: 'x' }] }, false);
    expect(r1.status).toBe(404);
    const r2 = await post('/v1/chat/completions', 'tk-bob', { model: 'secondary/raw-model', messages: [{ role: 'user', content: 'x' }], stream: false }, false);
    expect(r2.status).toBe(200);
    expect(r2.text).toContain('raw-model');
  });

  it('streams SSE when stream=true', async () => {
    const r = await post('/v1/chat/completions', 'tk-bob', { model: 'secondary/raw-model', messages: [{ role: 'user', content: 'x' }], stream: true }, true);
    expect(r.status).toBe(200);
    expect(r.text).toContain('data:');
    expect(r.text).toContain('[DONE]');
  });

  it('enforces per-user quota', async () => {
    const r = await post('/v1/chat/completions', 'tk-ana', { model: 'secondary/raw-model', messages: [{ role: 'user', content: 'z'.repeat(800) }], stream: false }, false);
    expect([200, 429]).toContain(r.status);
    const r2 = await post('/v1/chat/completions', 'tk-ana', { model: 'secondary/raw-model', messages: [{ role: 'user', content: 'y'.repeat(2000) }], stream: false }, false);
    expect(r2.status).toBe(429);
  });

  it('admin key bypasses quota', async () => {
    const r = await post('/v1/chat/completions', 'adminkey', { model: 'secondary/raw-model', messages: [{ role: 'user', content: 'y'.repeat(5000) }], stream: false }, false);
    expect(r.status).toBe(200);
  });

  it('answers OPTIONS preflight with CORS headers', async () => {
    const res = await fetch(base + '/v1/chat/completions', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('returns 400 on malformed URL encoding in admin routes', async () => {
    const { request } = await import('node:http');
    const u = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: u.hostname,
          port: u.port,
          path: '/admin/api/users/%zz',
          method: 'DELETE',
          headers: { authorization: 'Bearer adminkey' },
        },
        (r) => {
          r.resume();
          r.on('end', () => resolve(r.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
  });

  it('writes usage records to the usage file', async () => {
    const { readFileSync } = await import('node:fs');
    const records = readFileSync(cfg.usageFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as UsageRecord);
    const ana = records.filter((r) => r.name === 'ana');
    expect(ana.length).toBeGreaterThan(0);
    expect(ana.every((r) => r.promptTokens > 0)).toBe(true);
  });
});