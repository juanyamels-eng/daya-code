import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool, ToolContext, ToolResult } from '@daya-code/core';

const inputSchema = z.record(z.unknown());

export function registerTools(
  server: McpServer,
  tools: Tool[],
  ctx: ToolContext,
): void {
  for (const tool of tools) {
    const { name, description } = tool.definition;
    server.registerTool(
      name,
      {
        title: name,
        description,
        inputSchema,
      },
      async (args) => {
        const result = await tool.execute(args, ctx);
        return toMcpResult(result);
      },
    );
  }
}

function toMcpResult(result: ToolResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text' as const, text: result.output }],
    isError: result.isError,
  };
}
