import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../types.js';
import { ok, err } from '../index.js';
import { DayaClient, type WebSearchResponse } from '../../daya/client.js';

export const WebSearchInputSchema = z.object({
  query: z.string().min(1).describe('Search query.'),
  top_k: z.number().int().positive().max(20).optional().describe('How many results to return. Default 5.'),
  recency: z.enum(['day', 'week', 'month', 'year']).optional().describe('Restrict to recent results.'),
  site: z.string().optional().describe('Restrict to a specific site (e.g. "github.com").'),
});

export const WebSearchTool: Tool = {
  definition: {
    name: 'daya_web_search',
    description:
      'Search the public web via the DAYA API. Returns ranked results with title, URL, and snippet. Requires DAYA_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        top_k: { type: 'number' },
        recency: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
        site: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  execute: async (input, ctx) => webSearch(input, ctx),
};

export async function webSearch(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = WebSearchInputSchema.safeParse(input);
  if (!parsed.success) return err(`Invalid input: ${parsed.error.message}`);

  const client = ctxDayaClient(ctx);
  if (!client) return err('DAYA_API_KEY is not set; cannot call daya_web_search.');

  const { query, top_k, recency, site } = parsed.data;
  let res: WebSearchResponse;
  try {
    res = await client.webSearch({ query, top_k, recency, site }, { signal: ctx.signal });
  } catch (e) {
    return err(`DAYA web search failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (res.results.length === 0) return ok('No results.');

  const lines = res.results.map((r, i) => {
    const head = `#${i + 1} ${r.title}`;
    const url = r.url;
    const snip = r.snippet.replace(/\s+/g, ' ').trim();
    return `${head}\n  ${url}\n  ${snip}${r.publishedAt ? ` (${r.publishedAt})` : ''}`;
  });
  return ok(lines.join('\n\n'), { query, count: res.results.length });
}

function ctxDayaClient(ctx: ToolContext): DayaClient | null {
  return (ctx as unknown as { dayaClient?: DayaClient }).dayaClient ?? null;
}
