import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Upstream {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface GatewayUser {
  name: string;
  token: string;
  enabled: boolean;
  quota?: number;
}

export interface Topup {
  code: string;
  user: string;
  amountUsd: number;
  amountTokens: number;
  status: 'pending' | 'paid' | 'cancelled';
  ts: number;
  paidAt?: number;
}

export interface GatewayConfig {
  port: number;
  adminKey?: string;
  upstreams: Record<string, Upstream>;
  users: GatewayUser[];
  usageFile: string;
}

const DEFAULT_UPSTREAMS: Record<string, Upstream> = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1' },
  huggingface: { baseUrl: 'https://router.huggingface.co/v1' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1' },
  ollama: { baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama' },
};

const ENV_KEY: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  gemini: 'GEMINI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  huggingface: 'HF_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: 'OLLAMA_API_KEY',
};

export function defaultUpstreamHeaders(name: string): Record<string, string> | undefined {
  if (name === 'openrouter') {
    // Enable OpenRouter automatic prompt caching: repeated conversation
    // prefixes are served from cache at a steep discount. :path tags the
    // cache bucket with the request's route so identical prefixes reuse it.
    return { ':path': '/api/v1/chat/completions' };
  }
  return undefined;
}

export interface RawConfig {
  port?: number;
  adminKey?: string;
  usageFile?: string;
  upstreams?: Record<string, Partial<Upstream>>;
  users?: Partial<GatewayUser>[];
  topups?: Topup[];
}

export function configCandidates(): string[] {
  const out: string[] = [];
  if (process.env['GATEWAY_CONFIG']) out.push(process.env['GATEWAY_CONFIG'] as string);
  out.push(join(process.cwd(), 'daya.gateway.json'));
  out.push(join(homedir(), '.daya', 'gateway.json'));
  return out;
}

export function loadConfig(): GatewayConfig {
  const raw: RawConfig = {};
  for (const file of configCandidates()) {
    if (existsSync(file)) {
      Object.assign(raw, JSON.parse(readFileSync(file, 'utf8')));
      break;
    }
  }

  const upstreams: Record<string, Upstream> = {};
  for (const [name, def] of Object.entries(DEFAULT_UPSTREAMS)) {
    const override = raw.upstreams?.[name] ?? {};
    const envKey = ENV_KEY[name];
    upstreams[name] = {
      baseUrl: override.baseUrl ?? def.baseUrl,
      apiKey: override.apiKey ?? (envKey ? process.env[envKey] : undefined) ?? def.apiKey,
      headers: override.headers ?? defaultUpstreamHeaders(name),
    };
  }

  const users: GatewayUser[] = (raw.users ?? []).map((u) => ({
    name: String(u.name ?? 'user'),
    token: String(u.token ?? ''),
    enabled: u.enabled ?? true,
    quota: u.quota,
  }));

  return {
    port: raw.port ?? Number(process.env['GATEWAY_PORT'] ?? 8787),
    adminKey: raw.adminKey ?? process.env['GATEWAY_ADMIN_KEY'],
    upstreams,
    users,
    usageFile: raw.usageFile ?? process.env['GATEWAY_USAGE_FILE'] ?? join(homedir(), '.daya', 'gateway', 'usage.jsonl'),
  };
}

/** Returns the config file we persist admin edits to (first existing, else the first candidate). */
export function configFilePath(existing: GatewayConfig): string {
  for (const file of configCandidates()) {
    if (existsSync(file)) return file;
  }
  return process.env['GATEWAY_CONFIG'] ?? join(process.cwd(), 'daya.gateway.json');
}

/** Read the config file (or the accumulated env/upstream view) as a mutable JSON object. */
export function readConfigFile(path: string): RawConfig {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
  }
  return {};
}

export function writeConfigFile(path: string, raw: RawConfig): void {
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

export function upsertUser(raw: RawConfig, user: Partial<GatewayUser> & { name: string }): GatewayUser {
  raw.users = raw.users ?? [];
  const existing = raw.users.find((u) => u.name === user.name);
  const next: GatewayUser = {
    name: user.name,
    token: existing?.token ?? user.token ?? randomToken(),
    enabled: user.enabled ?? existing?.enabled ?? true,
    quota: user.quota !== undefined ? user.quota : existing?.quota,
  };
  if (existing) {
    Object.assign(existing, next);
  } else {
    (raw.users as GatewayUser[]).push(next);
  }
  return next;
}

export function removeUser(raw: RawConfig, name: string): boolean {
  if (!raw.users) return false;
  const before = raw.users.length;
  raw.users = raw.users.filter((u) => u.name !== name);
  return raw.users.length !== before;
}

export function randomToken(bytes = 24): string {
  return 'daya_' + randomBytes(bytes).toString('hex');
}