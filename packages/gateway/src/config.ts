import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Upstream {
  baseUrl: string;
  apiKey?: string;
}

export interface GatewayUser {
  name: string;
  token: string;
  enabled: boolean;
  quota?: number;
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

interface RawConfig {
  port?: number;
  adminKey?: string;
  usageFile?: string;
  upstreams?: Record<string, Partial<Upstream>>;
  users?: Partial<GatewayUser>[];
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
    upstreams[name] = {
      baseUrl: override.baseUrl ?? def.baseUrl,
      apiKey: override.apiKey ?? process.env[ENV_KEY[name]] ?? def.apiKey,
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