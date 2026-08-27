import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool, ToolContext, ToolResult } from '@daya-code/core';

export function registerTools(
  server: McpServer,
  tools: Tool[],
  ctx: ToolContext,
): void {
  for (const tool of tools) {
    const { name, description, inputSchema } = tool.definition;
    const zodSchema = jsonSchemaToZod(inputSchema as Record<string, unknown>);
    server.registerTool(
      name,
      {
        title: name,
        description,
        inputSchema: zodSchema,
      },
      async (args) => {
        const result = await tool.execute(args, ctx);
        return toMcpResult(result);
      },
    );
  }
}

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  const shape: Record<string, z.ZodType> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let field: z.ZodType;
    const t = prop.type as string | undefined;

    if (t === 'string') {
      const enums = prop.enum as string[] | undefined;
      field = enums ? z.enum(enums as [string, ...string[]]) : z.string();
    } else if (t === 'number' || t === 'integer') {
      field = z.number();
    } else if (t === 'boolean') {
      field = z.boolean();
    } else if (t === 'object') {
      field = z.record(z.unknown());
    } else if (t === 'array') {
      field = z.array(z.unknown());
    } else {
      field = z.unknown();
    }

    if (prop.description) {
      field = field.describe(prop.description as string);
    }

    if (!required.includes(key)) {
      field = field.optional();
    }

    shape[key] = field;
  }

  return z.object(shape);
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
