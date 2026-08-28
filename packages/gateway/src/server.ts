import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { MODEL_CATALOG } from './catalog.js';
import type { GatewayConfig, GatewayUser } from './config.js';
import { UsageStore, type UsageRecord } from './usage.js';
import { RateLimiter, quotaNear } from './ratelimit.js';
import {
  forwardChat,
  estimatePromptTokens,
  estimateCompletionTokens,
  ModelNotAvailableError,
  recordCost,
  type UpstreamResult,
} from './proxy.js';
import {
  handleAdminList,
  handleAdminUpsert,
  handleAdminDelete,
  handleAdminDashboard,
  handleAdminRotateToken,
  handleAdminPatch,
} from './admin.js';
import {
  handlePortal,
  handlePortalMe,
  buildPortalStats,
  userTopups,
} from './portal.js';
import {
  handleCreateTopup,
  handleListTopups,
  handleApproveTopup,
  handleCancelTopup,
  handleStripeCheckout,
  approveByCode,
} from './billing.js';
import { handleStripeWebhook } from './stripePay.js';

const MAX_BODY = 10 * 1024 * 1024;

export interface Identity {
  token: string;
  name: string;
  admin: boolean;
  quota?: number;
  rpm?: number;
}

// Configurable CORS origin; restrict it (e.g. https://your.domain) when the
// gateway is exposed past a browser. Defaults to * for API clients.
const CORS = {
  'access-control-allow-origin': process.env['GATEWAY_CORS_ORIGIN'] ?? '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
};

function json(res: ServerResponse, status: number, obj: unknown): void {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8', 'content-length': data.length });
  res.end(data);
}

/** Signals a client error (bad request body, malformed URL, etc.). */
class BadRequestError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (msg: string): void => {
      if (settled) return;
      settled = true;
      reject(new Error(msg));
      req.destroy();
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail('Payload too large');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => fail('Request stream error'));
    req.on('aborted', () => fail('Request aborted by client'));
    req.on('close', () => fail('Connection closed before request completed'));
  });
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  if (!auth) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1]!.trim() : undefined;
}

/** Constant-time string comparison to avoid leaking token contents via timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function authenticate(cfg: GatewayConfig, token: string | undefined): Identity | undefined {
  if (!token) return undefined;
  if (cfg.adminKey && safeEqual(token, cfg.adminKey)) {
    return { token, name: 'admin', admin: true };
  }
  const user = cfg.users.find((u) => u.enabled !== false && u.token && safeEqual(token, u.token));
  if (!user) return undefined;
  return { token, name: user.name, admin: false, quota: user.quota, rpm: user.rpm };
}

function checkQuota(id: Identity, usage: UsageStore, promptTokens: number): { ok: boolean; used: number | null } {
  if (id.admin || id.quota === undefined || id.quota <= 0) return { ok: true, used: null };
  const used = usage.monthTokens(id.token) + promptTokens;
  return { ok: used <= id.quota, used };
}

async function handleChat(cfg: GatewayConfig, identity: Identity, usage: UsageStore, limiter: RateLimiter, body: unknown, res: ServerResponse): Promise<void> {
  if (!body || typeof body !== 'object') {
    return json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request' } });
  }
  const reqBody = body as Record<string, unknown>;
  const model = typeof reqBody['model'] === 'string' ? reqBody['model'] : 'free';
  const isStream = reqBody['stream'] === true;

  // Rate limit per user (requests per minute).
  if (!identity.admin && !limiter.allow(identity.token, identity.rpm)) {
    return json(res, 429, {
      error: {
        message: `Rate limit exceeded (${identity.name}). Try again in a moment.`,
        type: 'rate_limited',
      },
    });
  }

  const promptTokens = estimatePromptTokens(reqBody);
  const quota = checkQuota(identity, usage, promptTokens);
  if (!quota.ok) {
    return json(res, 429, {
      error: { message: `Monthly quota exceeded (${identity.name})`, type: 'quota_exceeded' },
    });
  }

  // Warn when the user is within 10% of their monthly quota.
  const nearQuota = quotaNear(usage.monthTokens(identity.token), identity.quota);
  if (nearQuota) {
    res.setHeader('x-daya-quota-warning', '1');
  }

  // Clamp max_tokens to whatever is left of the monthly quota so one runaway
  // request cannot blow past it (admins and unlimited users are untouched).
  const upstreamBody: Record<string, unknown> = { ...reqBody };
  if (!identity.admin && typeof identity.quota === 'number' && identity.quota > 0) {
    const remaining = identity.quota - usage.monthTokens(identity.token);
    const cap = Math.max(1, Math.floor(remaining - promptTokens));
    const requested = typeof upstreamBody['max_tokens'] === 'number' ? (upstreamBody['max_tokens'] as number) : Infinity;
    if (cap < requested) upstreamBody['max_tokens'] = cap;
  }

  let forwarded;
  try {
    // If the client hangs up mid-request, stop spending tokens/bandwidth on
    // the upstream instead of streaming into the void.
    const clientGone = new AbortController();
    res.on('close', () => clientGone.abort());
    forwarded = await forwardChat(cfg, model, upstreamBody, identity.admin, clientGone.signal);
  } catch (err) {
    if (err instanceof ModelNotAvailableError) {
      return json(res, 404, { error: { message: err.message, type: 'model_not_found' } });
    }
    return json(res, 500, { error: { message: 'Internal error', type: 'internal_error' } });
  }

  const { outcome, result } = forwarded;
  if (!result.ok) {
    await writeUpstreamError(res, result);
    return;
  }

  const chosenName = outcome.chosen.upstream + '/' + outcome.chosen.model;

  if (isStream) {
    const out = new CompletionRecorder(promptTokens, chosenName, (rec) =>
      usage.record({ ...rec, token: identity.token, name: identity.name }),
    );
    await streamToClient(res, result, out);
    return;
  }

  const text = await collectText(result.body);
  const completionTokens = estimateCompletionTokens(text);
  const cost = recordCost(chosenName, promptTokens, completionTokens);
  usage.record({
    token: identity.token,
    name: identity.name,
    model: chosenName,
    upstream: outcome.chosen.upstream,
    promptTokens,
    completionTokens,
    costUsd: cost,
    ts: Date.now(),
  });
  res.writeHead(result.status, { ...CORS, ...result.headers });
  res.end(text);
}

async function writeUpstreamError(res: ServerResponse, result: UpstreamResult): Promise<void> {
  const text = await collectText(result.body);
  res.writeHead(result.status, { ...CORS, ...result.headers });
  res.end(text);
}

async function collectText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of body) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return text;
}

class CompletionRecorder {
  private completion = 0;
  private pending = '';

  constructor(
    private readonly promptTokens: number,
    private readonly model: string,
    private readonly onFinish: (rec: Omit<UsageRecord, 'name' | 'token'>) => void,
  ) {}

  feed(chunk: string): void {
    this.pending += chunk;
    for (;;) {
      const nl = this.pending.indexOf('\n');
      if (nl < 0) break;
      const line = this.pending.slice(0, nl).trim();
      this.pending = this.pending.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        const usage = obj['usage'] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (usage && typeof usage.completion_tokens === 'number') {
          this.completion = Math.max(this.completion, usage.completion_tokens);
          continue;
        }
        const choices = obj['choices'];
        if (Array.isArray(choices) && choices[0]) {
          const d = choices[0]['delta'] as { content?: string } | undefined;
          const content = d?.content;
          if (typeof content === 'string') this.completion += estimateCompletionTokens(content);
        }
      } catch {
        /* ignore partial frames */
      }
    }
  }

  finish(): void {
    const cost = recordCost(this.model, this.promptTokens, this.completion);
    void this.onFinish({
      model: this.model,
      upstream: this.model.split('/')[0] ?? '',
      promptTokens: this.promptTokens,
      completionTokens: this.completion,
      costUsd: cost,
      ts: Date.now(),
    });
  }
}

async function streamToClient(
  res: ServerResponse,
  result: UpstreamResult,
  recorder: CompletionRecorder,
): Promise<void> {
  res.writeHead(result.status, { ...CORS, 'content-type': result.headers['content-type'] ?? 'text/event-stream' });
  const decoder = new TextDecoder();
  for await (const chunk of result.body) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) {
      recorder.feed(text);
      res.write(text);
    }
  }
  recorder.finish();
  res.end();
}

export function createGateway(cfg: GatewayConfig, usage?: UsageStore): Server {
  const store = usage ?? new UsageStore(cfg.usageFile);
  const limiter = new RateLimiter();
  return createServer(async (req, res) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    try {
      // CORS preflight for browser clients hitting the OpenAI-compatible API.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }

      if (url === '/v1/models' && req.method === 'GET') {
        const data = MODEL_CATALOG.map((e) => ({ id: e.id, object: 'model', owned_by: 'daya-gateway', free: e.free }));
        return json(res, 200, { object: 'list', data });
      }

      // ---- Admin panel ----
      if (url === '/admin' || url === '/admin/') {
        const identity = authenticate(cfg, bearerToken(req));
        return handleAdminDashboard(identity, res);
      }
      if (url === '/admin/api/users' && req.method === 'GET') {
        const identity = authenticate(cfg, bearerToken(req));
        return handleAdminList(cfg, identity, (t) => store.monthTokens(t), res);
      }
      if (url === '/admin/api/users' && (req.method === 'POST' || req.method === 'PUT')) {
        const identity = authenticate(cfg, bearerToken(req));
        const raw = await readBody(req);
        let body: unknown = {};
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request' } });
        }
        return handleAdminUpsert(cfg, identity, body, res);
      }
      const nameOf = (suffix: string): string => {
        try {
          return decodeURIComponent(url.slice('/admin/api/users/'.length, suffix ? url.length - suffix.length : url.length));
        } catch {
          throw new BadRequestError('Invalid URL encoding');
        }
      };

      if (url.startsWith('/admin/api/users/') && req.method === 'PUT') {
        const identity = authenticate(cfg, bearerToken(req));
        const raw = await readBody(req);
        let body: unknown = {};
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request' } });
        }
        return handleAdminPatch(cfg, identity, nameOf(''), body, res);
      }
      if (url.startsWith('/admin/api/users/') && req.method === 'DELETE') {
        const identity = authenticate(cfg, bearerToken(req));
        return handleAdminDelete(cfg, identity, nameOf(''), res);
      }
      if (url.startsWith('/admin/api/users/') && req.method === 'POST' && url.endsWith('/rotate-token')) {
        const identity = authenticate(cfg, bearerToken(req));
        return handleAdminRotateToken(cfg, identity, nameOf('/rotate-token'), res);
      }

      // ---- User portal ----
      if (url === '/portal' || url === '/portal/') {
        return handlePortal(req.headers['host'] ? String(req.headers['host']) : undefined, res);
      }
      if (url === '/portal/api/me' && req.method === 'GET') {
        const identity = authenticate(cfg, bearerToken(req));
        return handlePortalMe(cfg, identity, (token) => {
          const s = store.userStats(token);
          const user = cfg.users.find((u) => u.token === token);
          const id: Identity = { token, name: user?.name ?? 'user', admin: false, quota: user?.quota };
          return buildPortalStats(id, s.monthTokens, s.monthCostUsd, s.requests, userTopups(cfg, id.name));
        }, res);
      }
      if (url === '/portal/api/topup' && req.method === 'POST') {
        const identity = authenticate(cfg, bearerToken(req));
        const raw = await readBody(req);
        let body: unknown = {};
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request' } });
        }
        return handleCreateTopup(cfg, identity, body, res);
      }
      if (url === '/portal/api/checkout' && req.method === 'POST') {
        const identity = authenticate(cfg, bearerToken(req));
        const host = req.headers['host'] ? String(req.headers['host']) : '';
        const baseUrl = process.env['GATEWAY_PUBLIC_URL'] ?? `http://${host}`;
        const raw = await readBody(req);
        let body: unknown = {};
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request' } });
        }
        return await handleStripeCheckout(cfg, identity, baseUrl, body, res);
      }

      // ---- Stripe webhook ----
      if (url === '/stripe/webhook' && req.method === 'POST') {
        const payload = await readBody(req);
        const signature = req.headers['stripe-signature'];
        const outcome = handleStripeWebhook(payload, signature ? String(signature) : undefined, (code) =>
          approveByCode(cfg, code),
        );
        res.setHeader('content-type', 'application/json');
        if (outcome === 'invalid') {
          res.statusCode = 400;
        } else if (outcome === 'unconfigured') {
          // No STRIPE_SECRET configured — tell Stripe to retry later instead
          // of silently swallowing the event.
          res.statusCode = 503;
        } else {
          res.statusCode = 200;
        }
        res.end(JSON.stringify({ received: true, outcome }));
        return;
      }

      // ---- Admin: top-ups / billing ----
      if (url === '/admin/api/topups' && req.method === 'GET') {
        const identity = authenticate(cfg, bearerToken(req));
        return handleListTopups(cfg, identity, res);
      }
      if (url.startsWith('/admin/api/topups/') && req.method === 'POST') {
        const identity = authenticate(cfg, bearerToken(req));
        const rest = url.slice('/admin/api/topups/'.length);
        if (rest.endsWith('/approve')) {
          const code = decodeURIComponent(rest.slice(0, -'/approve'.length));
          return handleApproveTopup(cfg, identity, code, res);
        }
        if (rest.endsWith('/cancel')) {
          const code = decodeURIComponent(rest.slice(0, -'/cancel'.length));
          return handleCancelTopup(cfg, identity, code, res);
        }
      }

      if (url !== '/v1/chat/completions' || req.method !== 'POST') {
        return json(res, 404, { error: { message: 'Not found', type: 'not_found' } });
      }

      const identity = authenticate(cfg, bearerToken(req));
      if (!identity) {
        return json(res, 401, { error: { message: 'Invalid API key', type: 'unauthorized' } });
      }

      const raw = await readBody(req);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request' } });
      }
      await handleChat(cfg, identity, store, limiter, body, res);
    } catch (err) {
      if (err instanceof BadRequestError) {
        if (!res.headersSent) json(res, 400, { error: { message: err.message, type: 'invalid_request' } });
        else res.end();
        return;
      }
      const tooLarge = err instanceof Error && err.message === 'Payload too large';
      const msg = tooLarge ? 'Payload too large' : 'Internal error';
      const code = tooLarge ? 413 : 500;
      if (!res.headersSent) json(res, code, { error: { message: msg, type: 'internal_error' } });
      else res.end();
    }
  });
}