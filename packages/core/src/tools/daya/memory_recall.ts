import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../types.js';
import { ok, err } from '../index.js';
import { LocalMemory } from '../../dayamemory/local.js';
import { DayaClient } from '../../daya/client.js';

export const MemoryRecallInputSchema = z.object({
  query: z.string().min(1).describe('Natural-language query to find relevant memories.'),
  namespace: z.string().optional().describe('Logical group. Defaults to the working directory.'),
  top_k: z.number().int().positive().max(50).optional().describe('How many memories to return. Default 5.'),
  include_remote: z.boolean().optional().describe('Also query the remote DAYA memory service. Default false.'),
});

export const MemoryRecallTool: Tool = {
  definition: {
    name: 'daya_memory_recall',
    description:
      'Recall previously-stored memories relevant to a query. Searches the local SQLite FTS5 index, and optionally the remote DAYA memory service. Use this to remember project conventions, user preferences, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        namespace: { type: 'string' },
        top_k: { type: 'number' },
        include_remote: { type: 'boolean' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  execute: async (input, ctx) => memoryRecall(input, ctx),
};

export async function memoryRecall(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = MemoryRecallInputSchema.safeParse(input);
  if (!parsed.success) return err(`Invalid input: ${parsed.error.message}`);

  const mem = ctxMemory(ctx);
  if (!mem) return err('Local memory store is not configured for this session.');

  const { query, namespace, top_k = 5, include_remote } = parsed.data;
  const ns = namespace ?? ctx.cwd.replace(/\\/g, '/').toLowerCase();

  const local = await mem.query(ns, query, top_k);
  let remote: { key: string; value: string; score: number; metadata?: Record<string, unknown> }[] = [];
  if (include_remote) {
    const client = ctxDayaClient(ctx);
    if (client) {
      try {
        const res = await client.memoryQuery({ namespace: ns, query, top_k }, { signal: ctx.signal });
        remote = res.results;
      } catch (e) {
        return err(`Local recall OK, remote recall failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const merged = mergeHits(local, remote).slice(0, top_k);
  if (merged.length === 0) return ok('No memories found.');

  const lines = merged.map((h, i) => `#${i + 1} [${h.source}] ${h.key} (score=${h.score.toFixed(3)})\n  ${h.value}`);
  return ok(lines.join('\n\n'), { count: merged.length, local: local.length, remote: remote.length });
}

function mergeHits(
  local: { key: string; value: string; score: number; metadata: Record<string, unknown> | null }[],
  remote: { key: string; value: string; score: number; metadata?: Record<string, unknown> }[],
): { source: string; key: string; value: string; score: number }[] {
  const map = new Map<string, { source: string; key: string; value: string; score: number }>();
  for (const h of local) {
    map.set(`local:${h.key}`, { source: 'local', key: h.key, value: h.value, score: -h.score });
  }
  for (const h of remote) {
    map.set(`remote:${h.key}`, { source: 'remote', key: h.key, value: h.value, score: -h.score });
  }
  return [...map.values()].sort((a, b) => a.score - b.score);
}

function ctxMemory(ctx: ToolContext): LocalMemory | null {
  return ctx.memory ?? null;
}
function ctxDayaClient(ctx: ToolContext): DayaClient | null {
  return ctx.dayaClient ?? null;
}
