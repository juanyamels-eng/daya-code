import { estimateCost } from '@daya-code/core';
import { getCatalogEntry, freeCatalogEntries, type CatalogEntry } from './catalog.js';
import type { GatewayConfig } from './config.js';

export interface Candidate {
  upstream: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  free: boolean;
  headers?: Record<string, string>;
}

export class ModelNotAvailableError extends Error {
  constructor(model: string) {
    super(`Unknown model: ${model}`);
  }
}

function resolveEntry(cfg: GatewayConfig, entry: CatalogEntry): Candidate {
  const up = cfg.upstreams[entry.upstream];
  if (!up) throw new ModelNotAvailableError(entry.id);
  return {
    upstream: entry.upstream,
    baseUrl: up.baseUrl,
    apiKey: up.apiKey ?? '',
    model: entry.upstreamModel,
    free: entry.free,
    headers: up.headers,
  };
}

export function resolveCandidates(cfg: GatewayConfig, model: string): Candidate[] {
  if (model === 'free' || model === 'auto') {
    const list: Candidate[] = [];
    for (const entry of freeCatalogEntries()) {
      try {
        list.push(resolveEntry(cfg, entry));
      } catch {
        /* skip upstreams not configured */
      }
    }
    if (list.length === 0) throw new ModelNotAvailableError(model);
    return list;
  }

  const entry = getCatalogEntry(model);
  if (entry) {
    const out: Candidate[] = [resolveEntry(cfg, entry)];
    for (const id of entry.failover ?? []) {
      const fb = getCatalogEntry(id);
      if (!fb) continue;
      try {
        out.push(resolveEntry(cfg, fb));
      } catch {
        /* skip */
      }
    }
    return out;
  }

  const slash = model.indexOf('/');
  if (slash > 0) {
    const upstreamName = model.slice(0, slash);
    const upstreamModel = model.slice(slash + 1);
    const up = cfg.upstreams[upstreamName];
    if (up) {
      return [
        {
          upstream: upstreamName,
          baseUrl: up.baseUrl,
          apiKey: up.apiKey ?? '',
          model: upstreamModel,
          free: false,
          headers: up.headers,
        },
      ];
    }
  }

  throw new ModelNotAvailableError(model);
}

export function estimateTokens(text: string | number): number {
  const len = typeof text === 'string' ? text.length : text;
  return Math.ceil(len / 4);
}

export function estimatePromptTokens(body: Record<string, unknown>): number {
  let chars = 0;
  const messages = body['messages'];
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (m && typeof m === 'object') {
        const content = (m as Record<string, unknown>)['content'];
        if (typeof content === 'string') chars += content.length;
        else if (Array.isArray(content)) {
          for (const part of content) {
            if (part && part['text']) chars += String(part['text']).length;
          }
        }
      }
    }
  }
  const sys = body['system'];
  if (typeof sys === 'string') chars += sys.length;
  return estimateTokens(chars);
}

export interface UpstreamResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  completionTokens: number;
}

async function callUpstream(
  cfg: GatewayConfig,
  candidate: Candidate,
  body: Record<string, unknown>,
  isAdmin: boolean,
): Promise<UpstreamResult> {
  const upstreamBody: Record<string, unknown> = { ...body, model: candidate.model };
  if (isAdmin || (body as { stream?: boolean }).stream === true) {
    upstreamBody['stream_options'] = { include_usage: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${candidate.apiKey}`,
  };
  const extra = candidate.headers;
  if (extra) {
    for (const [k, v] of Object.entries(extra)) headers[k] = v;
  }
  let response;
  try {
    response = await fetch(`${candidate.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    return { ok: false, status: 0, headers: {}, body: emptyBody(), completionTokens: 0 };
  }
  clearTimeout(timeout);

  const outHeaders: Record<string, string> = {};
  if (response.headers.get('content-type')) outHeaders['content-type'] = String(response.headers.get('content-type'));

  return {
    ok: response.ok,
    status: response.status,
    headers: outHeaders,
    body: response.body ? toAsyncIterable(response.body) : emptyBody(),
    completionTokens: 0,
  };
}

async function* toAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function emptyBody(): AsyncIterable<Uint8Array> {
  return (async function* () {
    return;
  })();
}

export interface ChatOutcome {
  candidates: Candidate[];
  chosen: Candidate;
}

export async function forwardChat(
  cfg: GatewayConfig,
  model: string,
  body: Record<string, unknown>,
  isAdmin: boolean,
  onUpstreamError?: (candidate: Candidate, status: number) => void,
): Promise<{ outcome: ChatOutcome; result: UpstreamResult }> {
  const candidates = resolveCandidates(cfg, model);
  let lastError = undefined as { status: number } | undefined;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const result = await callUpstream(cfg, candidate, body, isAdmin);
    if (result.ok) {
      return { outcome: { candidates, chosen: candidate }, result };
    }
    if (onUpstreamError) onUpstreamError(candidate, result.status);
    lastError = { status: result.status };
    await result.body[Symbol.asyncIterator]().next();
  }
  const finalStatus = lastError?.status && lastError.status >= 400 ? lastError.status : 502;
  const errText = finalStatus >= 500 ? 'Upstream request failed' : 'Upstream refused the request';
  const result: UpstreamResult = {
    ok: false,
    status: finalStatus,
    headers: { 'content-type': 'application/json' },
    body: jsonBody({ error: { message: errText, type: 'upstream_error' } }),
    completionTokens: 0,
  };
  const last = candidates[candidates.length - 1]!;
  return { outcome: { candidates, chosen: last }, result };
}

export function jsonBody(obj: unknown): AsyncIterable<Uint8Array> {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  return (async function* () {
    yield data;
  })();
}

export function estimateCompletionTokens(text: string): number {
  return estimateTokens(text);
}

export function recordCost(upstreamModel: string, promptTokens: number, completionTokens: number): number {
  return estimateCost(upstreamModel, promptTokens, completionTokens);
}