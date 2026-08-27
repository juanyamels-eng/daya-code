import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { PROVIDER_PRESETS } from '../providers/registry.js';

const ProviderNameSchema = z.enum([
  'mock',
  'anthropic',
  'openai',
  'openrouter',
  'daya',
  'openai-compatible',
  ...Object.keys(PROVIDER_PRESETS),
] as [string, ...string[]]);

const ProviderConfigSchema = z.object({
  name: ProviderNameSchema,
  model: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

const PermissionsConfigSchema = z.object({
  bash: z.enum(['allow', 'deny', 'prompt']),
  write: z.enum(['allow', 'deny', 'prompt']),
  edit: z.enum(['allow', 'deny', 'prompt']),
});

const McpServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const DayaConfigSchema = z.object({
  version: z.literal(1),
  provider: ProviderConfigSchema,
  permissions: PermissionsConfigSchema,
  sessions: z.object({ dir: z.string() }),
  mcpServers: z.record(McpServerConfigSchema),
  lintCmd: z.string().optional(),
  testCmd: z.string().optional(),
  autoCommit: z.boolean().optional(),
  architectModel: z.string().optional(),
  theme: z.string().optional(),
});

export type DayaConfig = z.infer<typeof DayaConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

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
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    const result = DayaConfigSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    return {
      ...DEFAULT_CONFIG,
      ...(parsed as Partial<DayaConfig>),
      provider: { ...DEFAULT_CONFIG.provider, ...((parsed as Partial<DayaConfig>).provider ?? {}) },
      permissions: { ...DEFAULT_CONFIG.permissions, ...((parsed as Partial<DayaConfig>).permissions ?? {}) },
      sessions: { ...DEFAULT_CONFIG.sessions, ...((parsed as Partial<DayaConfig>).sessions ?? {}) },
      mcpServers: (parsed as Partial<DayaConfig>).mcpServers ?? {},
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(cfg: DayaConfig, path: string = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2), 'utf8');
}

export function envOverrides(cfg: DayaConfig): DayaConfig {
  const apiKey = process.env.DAYA_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
  const providerName = process.env.DAYA_PROVIDER as DayaConfig['provider']['name'] | undefined;
  const model = process.env.DAYA_MODEL;
  const baseUrl = process.env.DAYA_BASE_URL;
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      ...(apiKey ? { apiKey } : {}),
      ...(providerName && ProviderNameSchema.safeParse(providerName).success ? { name: providerName } : {}),
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
}
