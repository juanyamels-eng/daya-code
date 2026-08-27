import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, type CoreMessage, type CoreTool } from 'ai';
import type { Provider, ProviderEvent, ProviderStreamParams, ToolDefinition } from '../types.js';
import { MockProvider } from './mock.js';

export type ProviderName = 'mock' | 'anthropic' | 'openai' | 'openrouter' | 'daya' | 'openai-compatible';

export interface ProviderOptions {
  name: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export function createProvider(opts: ProviderOptions): Provider {
  if (opts.name === 'mock' || !opts.apiKey) {
    return new MockProvider();
  }
  if (opts.name === 'anthropic') return new AnthropicProvider(opts.apiKey, opts.model);
  if (opts.name === 'openai') {
    return new OpenAIProvider(opts.apiKey, opts.model, opts.baseUrl, 'openai');
  }
  if (opts.name === 'openai-compatible') {
    return new OpenAIProvider(opts.apiKey, opts.model, opts.baseUrl, 'openai-compatible');
  }
  if (opts.name === 'openrouter') {
    return new OpenAIProvider(opts.apiKey, opts.model, 'https://openrouter.ai/api/v1', 'openrouter');
  }
  if (opts.name === 'daya') {
    return new OpenAIProvider(opts.apiKey, opts.model, 'https://api.daya.ai/v1', 'daya');
  }
  throw new Error(`Unknown provider: ${opts.name}`);
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

function toCoreMessages(messages: import('../types.js').Message[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const content: Array<Record<string, unknown>> = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          content.push({
            type: 'tool-use',
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.input as Record<string, unknown>,
          });
        }
      }
      out.push({ role: 'assistant', content: content as never });
    } else if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    } else if (m.role === 'tool') {
      const tr = {
        type: 'tool-result' as const,
        toolCallId: m.toolCallId ?? 'unknown',
        toolName: 'tool',
        result: m.content,
      };
      const last = out[out.length - 1];
      if (last && last.role === 'assistant' && Array.isArray(last.content)) {
        (last.content as unknown as Array<unknown>).push(tr);
      } else {
        out.push({ role: 'tool', content: [tr] as never });
      }
    }
  }
  return out;
}

function buildToolsObject(tools: ToolDefinition[]): Record<string, CoreTool> {
  const obj: Record<string, CoreTool> = {};
  for (const t of tools) {
    obj[t.name] = {
      description: t.description,
      parameters: t.inputSchema as never,
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
