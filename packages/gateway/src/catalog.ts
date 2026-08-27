export interface CatalogEntry {
  id: string;
  description: string;
  upstream: string;
  upstreamModel: string;
  free: boolean;
  failover?: string[];
}

export const MODEL_CATALOG: CatalogEntry[] = [
  {
    id: 'groq-llama',
    description: 'Llama 3.3 70B @ Groq (free, fast)',
    upstream: 'groq',
    upstreamModel: 'llama-3.3-70b-versatile',
    free: true,
    failover: ['groq-oss', 'cerebras-llama', 'gemini-flash', 'nim-llama', 'hf-llama', 'mistral-small'],
  },
  {
    id: 'groq-oss',
    description: 'OpenAI gpt-oss-120b @ Groq (free)',
    upstream: 'groq',
    upstreamModel: 'gpt-oss-120b',
    free: true,
    failover: ['cerebras-llama', 'gemini-flash', 'hf-llama'],
  },
  {
    id: 'cerebras-llama',
    description: 'Llama 3.3 70B @ Cerebras (free, fast)',
    upstream: 'cerebras',
    upstreamModel: 'llama-3.3-70b',
    free: true,
    failover: ['groq-llama', 'gemini-flash'],
  },
  {
    id: 'gemini-flash',
    description: 'Gemini 2.5 Flash @ Google AI Studio (free, 1M ctx)',
    upstream: 'gemini',
    upstreamModel: 'gemini-2.5-flash',
    free: true,
    failover: ['groq-llama', 'cerebras-llama'],
  },
  {
    id: 'nim-llama',
    description: 'Llama 3.3 70B @ NVIDIA NIM (free)',
    upstream: 'nvidia',
    upstreamModel: 'meta/llama-3.3-70b-instruct',
    free: true,
  },
  {
    id: 'mistral-small',
    description: 'mistral-small @ Mistral (free tier)',
    upstream: 'mistral',
    upstreamModel: 'mistral-small-latest',
    free: true,
  },
  {
    id: 'hf-llama',
    description: 'Llama 3.3 70B @ HuggingFace router (free)',
    upstream: 'huggingface',
    upstreamModel: 'meta-llama/Llama-3.3-70B-Instruct',
    free: true,
  },
  {
    id: 'or-free',
    description: 'OpenRouter free auto-router',
    upstream: 'openrouter',
    upstreamModel: 'openrouter/free',
    free: true,
  },
  {
    id: 'local',
    description: 'Local Ollama (no key, no cost)',
    upstream: 'ollama',
    upstreamModel: 'llama3.2',
    free: true,
  },
  {
    id: 'claude',
    description: 'Claude Sonnet 4.5 @ OpenRouter (paid)',
    upstream: 'openrouter',
    upstreamModel: 'anthropic/claude-sonnet-4-5',
    free: false,
    failover: ['gpt-4o'],
  },
  {
    id: 'gpt-4o',
    description: 'GPT-4o @ OpenRouter (paid)',
    upstream: 'openrouter',
    upstreamModel: 'openai/gpt-4o',
    free: false,
  },
  {
    id: 'gpt-4.1',
    description: 'GPT-4.1 @ OpenRouter (paid)',
    upstream: 'openrouter',
    upstreamModel: 'openai/gpt-4.1',
    free: false,
  },
  {
    id: 'deepseek',
    description: 'DeepSeek Chat @ OpenRouter (paid)',
    upstream: 'openrouter',
    upstreamModel: 'deepseek/deepseek-chat',
    free: false,
  },
  {
    id: 'qwen-coder',
    description: 'Qwen3 Coder 480B @ OpenRouter (paid)',
    upstream: 'openrouter',
    upstreamModel: 'qwen/qwen3-coder-480b-a35b-instruct',
    free: false,
  },
];

export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return MODEL_CATALOG.find((e) => e.id === id);
}

export function freeCatalogEntries(): CatalogEntry[] {
  return MODEL_CATALOG.filter((e) => e.free);
}