import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface DayaConfig {
  version: 1;
  provider: {
    name: 'mock' | 'anthropic' | 'openai' | 'openrouter' | 'daya';
    model: string;
    apiKey?: string;
    baseUrl?: string;
  };
  permissions: {
    bash: 'allow' | 'deny' | 'prompt';
    write: 'allow' | 'deny' | 'prompt';
    edit: 'allow' | 'deny' | 'prompt';
  };
  sessions: {
    dir: string;
  };
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

const DEFAULT_CONFIG: DayaConfig = {
  version: 1,
  provider: { name: 'mock', model: 'mock-echo-v1' },
  permissions: { bash: 'prompt', write: 'prompt', edit: 'prompt' },
  sessions: { dir: join(homedir(), '.daya', 'sessions') },
  mcpServers: {},
};

export function defaultConfigPath(): string {
  return join(homedir(), '.daya', 'config.json');
}

export async function loadConfig(path: string = defaultConfigPath()): Promise<DayaConfig> {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<DayaConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    provider: { ...DEFAULT_CONFIG.provider, ...(parsed.provider ?? {}) },
    permissions: { ...DEFAULT_CONFIG.permissions, ...(parsed.permissions ?? {}) },
    sessions: { ...DEFAULT_CONFIG.sessions, ...(parsed.sessions ?? {}) },
    mcpServers: parsed.mcpServers ?? {},
  };
}

export async function saveConfig(cfg: DayaConfig, path: string = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2), 'utf8');
}

export function envOverrides(cfg: DayaConfig): DayaConfig {
  const apiKey = process.env.DAYA_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
  const providerName = process.env.DAYA_PROVIDER as DayaConfig['provider']['name'] | undefined;
  const model = process.env.DAYA_MODEL;
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      ...(apiKey ? { apiKey } : {}),
      ...(providerName ? { name: providerName } : {}),
      ...(model ? { model } : {}),
    },
  };
}
