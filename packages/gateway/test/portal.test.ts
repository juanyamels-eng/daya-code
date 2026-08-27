import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server.js';
import type { GatewayConfig } from '../src/config.js';

let dir = '';
let cfg: GatewayConfig;
let gw: Server;
let base: string;
let mocks: Server[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gateway-portal-'));
  const up = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    });
  });
  up.listen(0);
  const { port } = up.address() as AddressInfo;
  mocks = [up];
  cfg = {
    port: 0,
    adminKey: 'adminkey',
    upstreams: { openrouter: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'ork' } },
    users: [
      { name: 'ana', token: 'tk-ana', enabled: true, quota: 1000 },
      { name: 'leo', token: 'tk-leo', enabled: true },
    ],
    usageFile: join(dir, 'usage.jsonl'),
  };
  gw = createGateway(cfg);
  await new Promise<void>((resolve) => gw.listen(0, resolve));
  const p = gw.address() as AddressInfo;
  base = `http://127.0.0.1:${p.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => gw.close(() => resolve()));
  for (const m of mocks) await new Promise<void>((resolve) => m.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function req(path: string, token?: string): Promise<{ status: number; text: string }> {
  const res = await fetch(base + path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, text: await res.text() };
}

describe('gateway user portal', () => {
  it('serves the portal HTML shell without auth', async () => {
    const r = await req('/portal');
    expect(r.status).toBe(200);
    expect(r.text).toContain('DAYA Gateway');
    expect(r.text).toContain('/portal/api/me');
  });

  it('returns 401 for /portal/api/me without a user token', async () => {
    const r = await req('/portal/api/me');
    expect(r.status).toBe(401);
  });

  it('shows a quota plan for a bounded user', async () => {
    const r = await req('/portal/api/me', 'tk-ana');
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text) as { name: string; plan: string; quota: number; monthTokens: number; monthCostUsd: number; freeModels: string[] };
    expect(d.name).toBe('ana');
    expect(d.plan).toBe('paid');
    expect(d.quota).toBe(1000);
    expect(d.monthTokens).toBe(0);
    expect(Array.isArray(d.freeModels)).toBe(true);
  });

  it('shows unlimited plan for a user without quota', async () => {
    const r = await req('/portal/api/me', 'tk-leo');
    const d = JSON.parse(r.text) as { plan: string; quota: null };
    expect(d.plan).toBe('unlimited');
    expect(d.quota).toBeNull();
  });

  it('records usage and reflects it in user stats', async () => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer tk-ana', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openrouter/test-free', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(200);
    const me = await req('/portal/api/me', 'tk-ana');
    const d = JSON.parse(me.text) as { monthTokens: number; requests: number };
    expect(d.monthTokens).toBeGreaterThan(0);
    expect(d.requests).toBe(1);
  });
});
