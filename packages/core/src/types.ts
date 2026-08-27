import { z } from 'zod';
import type { DayaClient } from './daya/client.js';
import type { LocalMemory } from './dayamemory/local.js';

export const RoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type Role = z.infer<typeof RoleSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  role: RoleSchema,
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  timestamp: z.number(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export type ProviderEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_use'; toolCall: ToolCall }
  | { type: 'message_complete'; message: Message }
  | { type: 'done'; reason: 'end_turn' | 'tool_use' | 'error' };

export interface Provider {
  readonly name: string;
  readonly model: string;
  stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent>;
}

export interface ProviderStreamParams {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type AgentMode = 'build' | 'plan';

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  permissions: PermissionChecker;
  emit?: (event: ToolEvent) => void;
  dayaClient?: DayaClient | null;
  memory?: LocalMemory | null;
  requestApproval?: (change: EditReviewChange) => Promise<boolean>;
}

export type ToolEvent =
  | { type: 'started'; name: string; input: unknown }
  | { type: 'output'; name: string; chunk: string }
  | { type: 'finished'; name: string; result: ToolResult };

export interface EditReviewChange {
  kind: 'edit' | 'write';
  path: string;
  old_text?: string;
  new_text: string;
  occurrences?: number;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Tool {
  readonly definition: ToolDefinition;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface PermissionDecision {
  allowed: boolean;
  remember?: 'once' | 'session' | 'never';
  reason?: string;
}

export interface PermissionChecker {
  check(action: PermissionAction): Promise<PermissionDecision>;
}

export type PermissionAction =
  | { kind: 'bash'; command: string }
  | { kind: 'write_file'; path: string }
  | { kind: 'edit_file'; path: string };

export const STOP_REASON_END_TURN = 'end_turn' as const;
export const STOP_REASON_TOOL_USE = 'tool_use' as const;
export const STOP_REASON_ERROR = 'error' as const;

export type StopReason = typeof STOP_REASON_END_TURN | typeof STOP_REASON_TOOL_USE | typeof STOP_REASON_ERROR;

export interface ContextInfo {
  estimatedTokens: number;
  maxTokens: number;
  messageCount: number;
  filesReferenced: string[];
  mode: AgentMode;
}
