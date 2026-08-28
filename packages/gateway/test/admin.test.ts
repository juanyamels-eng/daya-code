import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server.js';
import type { GatewayConfig } from '../src/config.js';
import { upsertUser, removeUser, defaultUpstreamHeaders, randomToken, type RawConfig } from '../src/config.js';
import { resolveCandidates } from '../src/proxy.js';

function mockUpstream(): { server: Server; baseUrl: string } {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    });
  });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

let mocks: Server[] = [];
let dir = '';
let cfg: GatewayConfig;
let gw: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gateway-admin-'));
  const up = mockUpstream();
  mocks = [up.server];
  cfg = {
    port: 0,
    adminKey: 'adminkey',
    upstreams: { openrouter: { baseUrl: up.baseUrl, apiKey: 'ork', headers: defaultUpstreamHeaders('openrouter') } },
    users: [{ name: 'ana', token: 'tk-ana', enabled: true }],
    usageFile: join(dir, 'usage.jsonl'),
  };
  gw = createGateway(cfg);
  await new Promise<void>((resolve) => gw.listen(0, resolve));
  const { port } = gw.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => gw.close(() => resolve()));
  for (const m of mocks) await new Promise<void>((resolve) => m.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function adminGet(path: string, token?: string): Promise<{ status: number; text: string }> {
  const res = await fetch(base + path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, text: await res.text() };
}

async function adminWrite(path: string, method: string, token: string | undefined, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

describe('gateway admin panel', () => {
  it('rejects admin routes without the admin key', async () => {
    const r = await adminGet('/admin/api/users');
    expect(r.status).toBe(401);
  });

  it('lists users with month usage and serves the dashboard as HTML', async () => {
    const r = await adminGet('/admin/api/users', 'adminkey');
    const json = JSON.parse(r.text) as { users: Array<{ name: string; monthTokens: number }> };
    expect(r.status).toBe(200);
    expect(json.users.find((u) => u.name === 'ana')?.monthTokens).toBe(0);

    const dash = await adminGet('/admin', 'adminkey');
    expect(dash.status).toBe(200);
    expect(dash.text).toContain('DAYA Gateway');
    expect(dash.text.includes('<html')).toBe(true);
  });

  it('creates a user and persists it to a config file', async () => {
    const file = join(dir, 'daya.gateway.json');
    process.env['GATEWAY_CONFIG'] = file;
    try {
      const r = await adminWrite('/admin/api/users', 'POST', 'adminkey', { name: 'carlos', token: 'tk-carlos', quota: 5000 });
      expect(r.status).toBe(200);
      const saved = JSON.parse(r.text) as { user: { name: string; token: string; quota: number } };
      expect(saved.user.name).toBe('carlos');
      expect(saved.user.token).toBe('tk-carlos');
      expect(existsSync(file)).toBe(true);
      const onDisk = JSON.parse(readFileSync(file, 'utf8')) as RawConfig;
      expect((onDisk.users as Array<{ name: string; quota: number }>).find((u) => u.name === 'carlos')?.quota).toBe(5000);
    } finally {
      delete process.env['GATEWAY_CONFIG'];
    }
  });

  it('deletes a user', async () => {
    const file = join(dir, 'daya.gateway.json');
    process.env['GATEWAY_CONFIG'] = file;
    try {
      const r = await adminWrite('/admin/api/users/carlos', 'DELETE', 'adminkey', {});
      expect(r.status).toBe(200);
      const r2 = await adminWrite('/admin/api/users/none', 'DELETE', 'adminkey', {});
      expect(r2.status).toBe(404);
    } finally {
      delete process.env['GATEWAY_CONFIG'];
    }
  });

  it('rotates a user token as admin', async () => {
    const file = join(dir, 'daya.gateway.json');
    process.env['GATEWAY_CONFIG'] = file;
    try {
      await adminWrite('/admin/api/users', 'POST', 'adminkey', { name: 'luna', token: 'tk-luna' });
      const r = await adminWrite('/admin/api/users/luna/rotate-token', 'POST', 'adminkey', {});
      expect(r.status).toBe(200);
      const d = JSON.parse(r.text) as { rotated: boolean; user: { name: string; token: string } };
      expect(d.rotated).toBe(true);
      expect(d.user.name).toBe('luna');
      expect(d.user.token.startsWith('daya_')).toBe(true);
      expect(d.user.token).not.toBe('tk-luna');

      const missing = await adminWrite('/admin/api/users/nobody/rotate-token', 'POST', 'adminkey', {});
      expect(missing.status).toBe(404);
    } finally {
      delete process.env['GATEWAY_CONFIG'];
    }
  });
});

describe('gateway config + cache helpers', () => {
  it('upsertUser adds and removes users and auto-generates tokens', () => {
    const raw: RawConfig = {};
    const u = upsertUser(raw, { name: 'x', enabled: true });
    expect(u.token.startsWith('daya_')).toBe(true);
    expect(upsertUser(raw, { name: 'x', token: 'custom' }).token).toBe(u.token);
    expect(removeUser(raw, 'x')).toBe(true);
    expect(removeUser(raw, 'x')).toBe(false);
  });

  it('applies OpenRouter cache headers to resolved candidates', () => {
    const candidates = resolveCandidates(
      { ...cfg, users: [] },
      'openrouter/anthropic/claude-3.5-sonnet',
    );
    expect(candidates[0]?.headers?.[':path']).toBe('/api/v1/chat/completions');
  });

  it('randomToken produces unique prefixed values', () => {
    const a = randomToken(16);
    const b = randomToken(16);
    expect(a).not.toBe(b);
    expect(a.startsWith('daya_')).toBe(true);
    expect(a.length).toBeGreaterThan(16);
  });
});
