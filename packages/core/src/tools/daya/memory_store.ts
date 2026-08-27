import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../types.js';
import { ok, err } from '../index.js';
import { LocalMemory } from '../../dayamemory/local.js';
import { DayaClient } from '../../daya/client.js';

export const MemoryStoreInputSchema = z.object({
  key: z.string().min(1).describe('Short identifier (e.g. "project:package_manager").'),
  value: z.string().describe('The fact or note to remember.'),
  namespace: z.string().optional().describe('Logical group. Defaults to the working directory.'),
  ttl_seconds: z.number().int().positive().optional().describe('Optional expiry.'),
  sync: z.boolean().optional().describe('Also upload to the remote DAYA memory service (default: false).'),
  metadata: z.record(z.unknown()).optional(),
});

export const MemoryStoreTool: Tool = {
  definition: {
    name: 'daya_memory_store',
    description:
      'Persist a small fact or preference that the agent should remember in future sessions. Stored locally in SQLite and optionally synced to the DAYA memory service.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
        namespace: { type: 'string' },
        ttl_seconds: { type: 'number' },
        sync: { type: 'boolean' },
        metadata: { type: 'object', additionalProperties: true },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
  execute: async (input, ctx) => memoryStore(input, ctx),
};

export async function memoryStore(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = MemoryStoreInputSchema.safeParse(input);
  if (!parsed.success) return err(`Invalid input: ${parsed.error.message}`);

  const mem = ctxMemory(ctx);
  if (!mem) return err('Local memory store is not configured for this session.');

  const { key, value, namespace, ttl_seconds, sync, metadata } = parsed.data;
  const ns = namespace ?? ctx.cwd.replace(/\\/g, '/').toLowerCase();
  const expiresAt = ttl_seconds ? Date.now() + ttl_seconds * 1000 : null;

  const { id, updated } = await mem.upsert({
    namespace: ns,
    key,
    value,
    metadata: metadata ?? null,
    expiresAt,
  });

  if (sync) {
    const client = ctxDayaClient(ctx);
    if (!client) return err('sync=true but DAYA_API_KEY is not set.');
    try {
      await client.memoryUpsert(
        { namespace: ns, key, value, metadata, ttl_seconds },
        { signal: ctx.signal },
      );
    } catch (e) {
      return err(`Stored locally (id=${id}) but remote sync failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return ok(`${updated ? 'Updated' : 'Stored'} memory "${key}" in namespace "${ns}" (id=${id}).`, {
    id,
    namespace: ns,
    key,
    updated,
  });
}

function ctxMemory(ctx: ToolContext): LocalMemory | null {
  return ctx.memory ?? null;
}
function ctxDayaClient(ctx: ToolContext): DayaClient | null {
  return ctx.dayaClient ?? null;
}
