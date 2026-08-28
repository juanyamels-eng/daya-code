import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server.js';
import type { GatewayConfig, RawConfig, Topup, GatewayUser } from '../src/config.js';

let dir = '';
let file = '';
let cfg: GatewayConfig;
let gw: Server;
let base: string;
let mocks: Server[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gateway-billing-'));
  file = join(dir, 'daya.gateway.json');
  process.env['GATEWAY_CONFIG'] = file;
  const up = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  up.listen(0);
  const { port } = up.address() as AddressInfo;
  mocks = [up];
  cfg = {
    port: 0,
    adminKey: 'adminkey',
    upstreams: { openrouter: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'ork' } },
    users: [{ name: 'ana', token: 'tk-ana', enabled: true, quota: 100 }],
    usageFile: join(dir, 'usage.jsonl'),
  };
  writeFileSync(file, JSON.stringify({ users: cfg.users }), 'utf8');
  gw = createGateway(cfg);
  await new Promise<void>((resolve) => gw.listen(0, resolve));
  const p = gw.address() as AddressInfo;
  base = `http://127.0.0.1:${p.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => gw.close(() => resolve()));
  for (const m of mocks) await new Promise<void>((resolve) => m.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  delete process.env['GATEWAY_CONFIG'];
});

async function request(path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

describe('gateway billing (manual top-ups)', () => {
  it('user creates a pending top-up and only with their own key', async () => {
    const r = await request('/portal/api/topup', { method: 'POST', token: 'tk-ana', body: { usd: 10 } });
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text) as { topup: Topup };
    expect(d.topup.status).toBe('pending');
    expect(d.topup.user).toBe('ana');
    expect(d.topup.amountTokens).toBe(10 * 250_000);

    const noauth = await request('/portal/api/topup', { method: 'POST', body: { usd: 10 } });
    expect(noauth.status).toBe(401);
  });

  it('rejects amounts out of range', async () => {
    const r = await request('/portal/api/topup', { method: 'POST', token: 'tk-ana', body: { usd: 1 } });
    expect(r.status).toBe(400);
  });

  it('admin lists pending top-ups', async () => {
    const created = JSON.parse((await request('/portal/api/topup', { method: 'POST', token: 'tk-ana', body: { usd: 20 } })).text) as { topup: Topup };
    const d = JSON.parse((await request('/admin/api/topups', { token: 'adminkey' })).text) as { topups: Topup[] };
    expect(d.topups.some((t) => t.code === created.topup.code && t.status === 'pending')).toBe(true);
  });

  it('admin approves a top-up and credits the user quota', async () => {
    const created = JSON.parse((await request('/portal/api/topup', { method: 'POST', token: 'tk-ana', body: { usd: 5 } })).text) as { topup: Topup };
    const before = cfg.users.find((u) => u.name === 'ana')?.quota ?? 0;
    const r = await request(`/admin/api/topups/${created.topup.code}/approve`, { method: 'POST', token: 'adminkey' });
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text) as { newQuota: number; previousQuota: number };
    expect(d.previousQuota).toBe(before);
    expect(d.newQuota).toBe(before + 5 * 250_000);

    const disk = JSON.parse(readFileSync(file, 'utf8')) as RawConfig;
    const user = (disk.users as GatewayUser[]).find((u) => u.name === 'ana');
    expect(user?.quota).toBe(before + 5 * 250_000);
    const topup = (disk.topups as Topup[]).find((t) => t.code === created.topup.code);
    expect(topup?.status).toBe('paid');
  });

  it('approving twice is rejected (not pending)', async () => {
    const created = JSON.parse((await request('/portal/api/topup', { method: 'POST', token: 'tk-ana', body: { usd: 5 } })).text) as { topup: Topup };
    await request(`/admin/api/topups/${created.topup.code}/approve`, { method: 'POST', token: 'adminkey' });
    const second = await request(`/admin/api/topups/${created.topup.code}/approve`, { method: 'POST', token: 'adminkey' });
    expect(second.status).toBe(404);
  });

  it('admin can cancel a pending top-up', async () => {
    const created = JSON.parse((await request('/portal/api/topup', { method: 'POST', token: 'tk-ana', body: { usd: 5 } })).text) as { topup: Topup };
    const r = await request(`/admin/api/topups/${created.topup.code}/cancel`, { method: 'POST', token: 'adminkey' });
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text) as { topup: Topup };
    expect(d.topup.status).toBe('cancelled');
  });
});

describe('gateway stripe integration (fallback when unconfigured)', () => {
  it('/portal/api/checkout falls back to manual mode without STRIPE_SECRET_KEY', async () => {
    const r = await request('/portal/api/checkout', { method: 'POST', token: 'tk-ana', body: { usd: 10 } });
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text) as { mode: string; topup: Topup };
    expect(d.mode).toBe('manual');
    expect(d.topup.status).toBe('pending');
  });

  it('rejects checkout with invalid amount', async () => {
    const r = await request('/portal/api/checkout', { method: 'POST', token: 'tk-ana', body: { usd: 1 } });
    expect(r.status).toBe(400);
  });

it('stripe webhook returns 503-unconfigured and does not crash', async () => {
    const r = await request('/stripe/webhook', { method: 'POST', body: JSON.stringify({}) });
    expect(r.status).toBe(503);
    const d = JSON.parse(r.text) as { outcome: string };
    expect(d.outcome).toBe('unconfigured');
  });
});
