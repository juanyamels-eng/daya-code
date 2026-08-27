import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../types.js';
import { ok, err } from '../index.js';
import { DayaClient, type DocumentsQueryResponse } from '../../daya/client.js';

export const DocumentsQueryInputSchema = z.object({
  query: z.string().min(1).describe('Natural-language question or query.'),
  top_k: z.number().int().positive().max(20).optional().describe('How many chunks to return. Default 5.'),
  collection: z.string().optional().describe('Restrict to a specific document collection.'),
  filter: z.record(z.unknown()).optional().describe('Optional metadata filter.'),
});

export const DocumentsQueryTool: Tool = {
  definition: {
    name: 'daya_documents_query',
    description:
      'Run a semantic query over user-uploaded documents via the DAYA RAG API. Returns the top matching chunks with title, source, and score. Requires DAYA_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        top_k: { type: 'number' },
        collection: { type: 'string' },
        filter: { type: 'object', additionalProperties: true },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  execute: async (input, ctx) => documentsQuery(input, ctx),
};

export async function documentsQuery(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = DocumentsQueryInputSchema.safeParse(input);
  if (!parsed.success) return err(`Invalid input: ${parsed.error.message}`);

  const client = ctxDayaClient(ctx);
  if (!client) return err('DAYA_API_KEY is not set; cannot call daya_documents_query.');

  const { query, top_k, collection, filter } = parsed.data;
  let res: DocumentsQueryResponse;
  try {
    res = await client.documentsQuery({ query, top_k, collection, filter }, { signal: ctx.signal });
  } catch (e) {
    return err(`DAYA documents query failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (res.results.length === 0) return ok('No matching documents.');

  const lines = res.results.map((r, i) => {
    const head = r.title ? `#${i + 1} ${r.title}` : `#${i + 1} ${r.id}`;
    const meta = r.source ? ` (${r.source})` : '';
    const score = `score=${r.score.toFixed(3)}`;
    const content = r.content.replace(/\s+/g, ' ').trim();
    return `${head}${meta} ${score}\n  ${content}`;
  });
  return ok(lines.join('\n\n'), { count: res.results.length });
}

function ctxDayaClient(ctx: ToolContext): DayaClient | null {
  return (ctx as unknown as { dayaClient?: DayaClient }).dayaClient ?? null;
}
