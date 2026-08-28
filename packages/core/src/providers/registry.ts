import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, streamText, type CoreMessage, type CoreTool } from 'ai';
import { z } from 'zod';
import type { Provider, ProviderEvent, ProviderStreamParams, ToolDefinition } from '../types.js';
import { MockProvider } from './mock.js';

export type ProviderName =
  | 'mock'
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'daya'
  | 'openai-compatible'
  | 'groq'
  | 'cerebras'
  | 'gemini'
  | 'nvidia'
  | 'mistral'
  | 'github-models'
  | 'huggingface'
  | 'ollama';

export interface ProviderPreset {
  baseUrl: string;
  model: string;
  needsKey: boolean;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b', needsKey: true },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', needsKey: true },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free', needsKey: true },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.3-70b-instruct', needsKey: true },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', needsKey: true },
  'github-models': { baseUrl: 'https://models.github.ai/inference', model: 'gpt-4.1', needsKey: true },
  huggingface: { baseUrl: 'https://router.huggingface.co/v1', model: 'meta-llama/Llama-3.3-70B-Instruct', needsKey: true },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', needsKey: false },
};

export const PRESET_NAMES = Object.keys(PROVIDER_PRESETS);

/** The environment variable that supplies the API key for each provider. */
export const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  daya: 'DAYA_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  gemini: 'GEMINI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  'github-models': 'GITHUB_MODELS_API_KEY',
  huggingface: 'HF_API_KEY',
  ollama: 'OLLAMA_API_KEY',
};

export function missingProviderKey(providerName: string, envKey = PROVIDER_ENV_KEYS[providerName]): Error {
  const hint = envKey ? `Set ${envKey}` : 'Pass an API key';
  return new Error(
    `[daya] provider "${providerName}" requires an API key. ${hint} (or use --api-key / set one in ~/.daya/config.json).`,
  );
}

export interface ProviderOptions {
  name: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export function createProvider(opts: ProviderOptions): Provider {
  if (opts.name === 'mock') {
    return new MockProvider();
  }
  if (opts.name === 'anthropic') {
    if (!opts.apiKey) throw missingProviderKey('anthropic');
    return new AnthropicProvider(opts.apiKey, opts.model);
  }
  if (opts.name === 'openai' || opts.name === 'openai-compatible') {
    if (!opts.apiKey) throw missingProviderKey(opts.name);
    return new OpenAIProvider(opts.apiKey, opts.model, opts.baseUrl, opts.name);
  }
  if (opts.name === 'openrouter') return openaiPreset('openrouter', opts);
  if (opts.name === 'daya') {
    if (!opts.apiKey) throw missingProviderKey('daya');
    return new OpenAIProvider(opts.apiKey, opts.model, 'https://api.daya.ai/v1', 'daya');
  }
  if (opts.name in PROVIDER_PRESETS) return openaiPreset(opts.name, opts);
  throw new Error(`Unknown provider: ${opts.name}`);
}

function openaiPreset(name: string, opts: ProviderOptions): Provider {
  const preset = PROVIDER_PRESETS[name]!;
  if (!opts.apiKey && preset.needsKey) throw missingProviderKey(name);
  const apiKey = opts.apiKey ?? 'ollama';
  const baseUrl = opts.baseUrl ?? preset.baseUrl;
  const model = opts.model === 'mock-echo-v1' ? preset.model : (opts.model || preset.model);
  return new OpenAIProvider(apiKey, model, baseUrl, name);
}

export interface FallbackConfig {
  primary: ProviderOptions;
  fallbacks: ProviderOptions[];
}

export class FallbackProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private providers: Provider[];
  private currentIdx = 0;

  constructor(config: FallbackConfig) {
    this.name = config.primary.name;
    this.model = config.primary.model;
    this.providers = [
      createProvider(config.primary),
      ...config.fallbacks.map((f) => createProvider(f)),
    ];
  }

  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    let lastError: Error | null = null;
    for (let i = this.currentIdx; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      try {
        yield* provider.stream(params);
        this.currentIdx = i;
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.currentIdx = i + 1;
      }
    }
    throw lastError ?? new Error('All providers failed');
  }
}

export function toCoreMessages(messages: import('../types.js').Message[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const content: Array<Record<string, unknown>> = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          toolNames.set(tc.id, tc.name);
          content.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.input as Record<string, unknown>,
          });
        }
      }
      out.push({ role: 'assistant', content: content as never });
    } else if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    } else if (m.role === 'tool') {
      // Tool results must live in their own `role: 'tool'` message — the AI SDK
      // rejects mixing tool-use and tool-result parts inside one assistant
      // message (InvalidPromptError / TypeValidationError).
      const tr = {
        type: 'tool-result' as const,
        toolCallId: m.toolCallId ?? 'unknown',
        toolName: toolNames.get(m.toolCallId ?? '') ?? 'tool',
        result: m.content,
      };
      out.push({ role: 'tool', content: [tr] as never });
    }
  }
  return out;
}

function buildToolsObject(tools: ToolDefinition[]): Record<string, CoreTool> {
  const obj: Record<string, CoreTool> = {};
  for (const t of tools) {
    const schema = t.inputSchema as unknown;
    // Tools ship either a raw JSON Schema (base tools) or a zod instance
    // (daya/memory tools). The AI SDK requires a Schema — pass zod through
    // untouched and wrap plain JSON Schema objects with jsonSchema().
    const parameters = schema instanceof z.ZodType ? schema : jsonSchema(schema as never);
    obj[t.name] = {
      description: t.description,
      parameters: parameters as never,
    } as CoreTool;
  }
  return obj;
}

abstract class BaseAIProvider implements Provider {
  abstract readonly name: string;
  abstract readonly model: string;

  protected abstract modelInstance(): Parameters<typeof streamText>[0]['model'];

  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    const messages = toCoreMessages(params.messages);
    const tools = buildToolsObject(params.tools);

    const result = await streamText({
      model: this.modelInstance(),
      system: params.system,
      messages,
      tools,
      maxTokens: params.maxTokens ?? 4096,
      temperature: params.temperature,
      abortSignal: params.signal,
    } as Parameters<typeof streamText>[0]);

    let emittedAnyTool = false;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          yield { type: 'text_delta', delta: part.textDelta };
          break;
        case 'tool-call':
          emittedAnyTool = true;
          yield {
            type: 'tool_use',
            toolCall: {
              id: part.toolCallId,
              name: part.toolName,
              input: (part.args as Record<string, unknown>) ?? {},
            },
          };
          break;
        case 'error':
          throw new Error(String(part.error));
        default:
          break;
      }
    }

    yield { type: 'done', reason: emittedAnyTool ? 'tool_use' : 'end_turn' };
  }
}

class AnthropicProvider extends BaseAIProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private client: ReturnType<typeof createAnthropic>;
  constructor(apiKey: string, model: string) {
    super();
    this.model = model;
    this.client = createAnthropic({ apiKey });
  }
  protected modelInstance() {
    return this.client(this.model);
  }
}

class OpenAIProvider extends BaseAIProvider {
  readonly name: string;
  readonly model: string;
  private client: ReturnType<typeof createOpenAI>;
  constructor(apiKey: string, model: string, baseUrl?: string, name: string = 'openai') {
    super();
    this.name = name;
    this.model = model;
    this.client = createOpenAI({ apiKey, baseURL: baseUrl });
  }
  protected modelInstance() {
    return this.client(this.model);
  }
}
