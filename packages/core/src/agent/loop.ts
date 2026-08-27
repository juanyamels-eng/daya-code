import { nanoid } from 'nanoid';
import type {
  Message,
  Provider,
  ProviderEvent,
  PermissionChecker,
  StopReason,
  Tool,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../types.js';
import { DayaClient } from '../daya/client.js';
import { LocalMemory } from '../dayamemory/local.js';

export interface AgentDeps {
  provider: Provider;
  tools: Tool[];
  permissions: PermissionChecker;
  cwd: string;
  system?: string;
  maxSteps?: number;
  daya?: AgentDayaConfig;
}

export interface AgentDayaConfig {
  client?: DayaClient | null;
  memory?: LocalMemory | null;
  namespace?: string;
  autoRecall?: boolean;
  autoRecallTopK?: number;
}

export interface AgentEvent {
  type:
    | 'user_message'
    | 'assistant_text_delta'
    | 'assistant_message'
    | 'tool_started'
    | 'tool_output'
    | 'tool_finished'
    | 'tool_denied'
    | 'done'
    | 'error';
  data: unknown;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  history?: Message[];
}

const DEFAULT_SYSTEM = `You are DAYA Code, a terminal code agent.
You help users modify codebases by reading, editing and running commands.
Use the available tools to inspect the repo before making changes.
Be concise, explain your plan before mutating files, and prefer minimal diffs.`;

const DEFAULT_MAX_STEPS = 25;

export class Agent {
  private readonly deps: AgentDeps;

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  toolDefinitions(): ToolDefinition[] {
    return this.deps.tools.map((t) => t.definition);
  }

  async run(prompt: string, options: AgentRunOptions = {}): Promise<Message[]> {
    const messages: Message[] = options.history ? [...options.history] : [];
    const baseSystem = this.deps.system ?? DEFAULT_SYSTEM;
    const system = await this.composeSystem(baseSystem, prompt);
    const maxSteps = this.deps.maxSteps ?? DEFAULT_MAX_STEPS;
    const signal = options.signal ?? new AbortController().signal;

    messages.push({
      id: nanoid(),
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    });
    options.onEvent?.({ type: 'user_message', data: messages[messages.length - 1] });

    let steps = 0;
    while (steps < maxSteps) {
      if (signal.aborted) {
        throw new Error('aborted');
      }
      steps += 1;

      const events = this.deps.provider.stream({
        system,
        messages,
        tools: this.toolDefinitions(),
        signal,
      });

      let textAccum = '';
      const toolCalls: ToolCall[] = [];

      for await (const ev of events) {
        if (signal.aborted) break;
        await this.handleProviderEvent(ev, {
          onText: (delta) => {
            textAccum += delta;
            options.onEvent?.({ type: 'assistant_text_delta', data: { delta } });
          },
          onToolUse: (toolCall) => {
            toolCalls.push(toolCall);
          },
          onMessage: (msg) => {
            options.onEvent?.({ type: 'assistant_message', data: msg });
          },
        });
      }

      const assistantMsg: Message = {
        id: nanoid(),
        role: 'assistant',
        content: textAccum,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        timestamp: Date.now(),
      };
      messages.push(assistantMsg);

      if (toolCalls.length === 0) {
        options.onEvent?.({ type: 'done', data: { reason: 'end_turn' as StopReason, messages } });
        return messages;
      }

      await this.executeToolCalls(toolCalls, {
        signal,
        onEvent: options.onEvent,
        onResult: (id, result) => {
          messages.push({
            id: nanoid(),
            role: 'tool',
            content: result.output,
            toolCallId: id,
            timestamp: Date.now(),
          });
        },
      });
    }

    options.onEvent?.({ type: 'done', data: { reason: 'tool_use' as StopReason, messages } });
    return messages;
  }

  private async composeSystem(base: string, prompt: string): Promise<string> {
    const daya = this.deps.daya;
    if (!daya || daya.autoRecall === false) return base;
    if (!daya.memory) return base;
    const ns = daya.namespace ?? this.deps.cwd.replace(/\\/g, '/').toLowerCase();
    const topK = daya.autoRecallTopK ?? 5;
    let hits: { key: string; value: string; score: number }[] = [];
    try {
      hits = await daya.memory.query(ns, prompt, topK);
    } catch {
      return base;
    }
    if (hits.length === 0) return base;
    const lines = hits.map((h) => `- [${h.key}] ${h.value}`);
    return `${base}\n\n## Relevant memories for this project\nThe following facts were remembered from prior sessions. Use them if relevant, ignore them if not.\n${lines.join('\n')}`;
  }

  private async handleProviderEvent(
    ev: ProviderEvent,
    handlers: {
      onText: (delta: string) => void;
      onToolUse: (tc: ToolCall) => void;
      onMessage: (m: Message) => void;
    },
  ): Promise<void> {
    switch (ev.type) {
      case 'text_delta':
        handlers.onText(ev.delta);
        break;
      case 'tool_use':
        handlers.onToolUse(ev.toolCall);
        break;
      case 'message_complete':
        handlers.onMessage(ev.message);
        break;
      case 'done':
        break;
    }
  }

  private async executeToolCalls(
    calls: ToolCall[],
    ctx: { signal: AbortSignal; onEvent?: (e: AgentEvent) => void; onResult: (id: string, r: ToolResult) => void },
  ): Promise<void> {
    for (const call of calls) {
      if (ctx.signal.aborted) break;
      const tool = this.deps.tools.find((t) => t.definition.name === call.name);
      if (!tool) {
        const result: ToolResult = { output: `Tool "${call.name}" not found.`, isError: true };
        ctx.onEvent?.({ type: 'tool_finished', data: { id: call.id, name: call.name, result } });
        ctx.onResult(call.id, result);
        continue;
      }

      ctx.onEvent?.({ type: 'tool_started', data: { id: call.id, name: call.name, input: call.input } });

      const toolCtx: ToolContext = {
        cwd: this.deps.cwd,
        signal: ctx.signal,
        permissions: this.deps.permissions,
        ...(this.deps.daya?.client ? { dayaClient: this.deps.daya.client } : {}),
        ...(this.deps.daya?.memory ? { memory: this.deps.daya.memory } : {}),
      } as ToolContext;

      try {
        const result = await tool.execute(call.input, toolCtx);
        ctx.onEvent?.({ type: 'tool_finished', data: { id: call.id, name: call.name, result } });
        ctx.onResult(call.id, result);
      } catch (err) {
        const result: ToolResult = {
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        };
        ctx.onEvent?.({ type: 'tool_finished', data: { id: call.id, name: call.name, result } });
        ctx.onResult(call.id, result);
      }
    }
  }
}
