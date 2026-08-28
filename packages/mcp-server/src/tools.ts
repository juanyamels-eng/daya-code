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

export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const t = schema.type as string | undefined;

  if (
    t === undefined &&
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((v) => typeof v === 'string')
  ) {
    return z.enum(schema.enum as [string, ...string[]]);
  }

  if (!t || t === 'object') {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = (schema.required ?? []) as string[];
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [keyInternal, prop] of Object.entries(properties)) {
      let field: z.ZodTypeAny = jsonSchemaToZod(prop);
      if (prop.description) {
        field = field.describe(prop.description as string);
      }
      if (!required.includes(keyInternal)) {
        field = field.optional();
      }
      shape[keyInternal] = field;
    }

    const object = z.object(shape);
    return schema.additionalProperties === false ? object.strict() : object;
  }

  if (t === 'string') {
    const enums = schema.enum as string[] | undefined;
    if (enums && enums.length > 0) {
      return z.enum(enums as [string, ...string[]]);
    }
    const minLength = schema.minLength as number | undefined;
    const maxLength = schema.maxLength as number | undefined;
    const pattern = schema.pattern as string | undefined;
    let field: z.ZodString = z.string();
    if (typeof minLength === 'number') field = field.min(minLength);
    if (typeof maxLength === 'number') field = field.max(maxLength);
    if (typeof pattern === 'string') {
      try {
        field = field.regex(new RegExp(pattern));
      } catch {
        // invalid regex in schema — leave the field unconstrained
      }
    }
    return field;
  }
  if (t === 'integer') {
    const minimum = schema.minimum as number | undefined;
    const maximum = schema.maximum as number | undefined;
    let field: z.ZodNumber = z.number().int();
    if (typeof minimum === 'number') field = field.min(minimum);
    if (typeof maximum === 'number') field = field.max(maximum);
    return field;
  }
  if (t === 'number') {
    const minimum = schema.minimum as number | undefined;
    const maximum = schema.maximum as number | undefined;
    let field: z.ZodNumber = z.number();
    if (typeof minimum === 'number') field = field.min(minimum);
    if (typeof maximum === 'number') field = field.max(maximum);
    return field;
  }
  if (t === 'boolean') {
    return z.boolean();
  }
  if (t === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    return items ? z.array(jsonSchemaToZod(items)) : z.array(z.unknown());
  }
  if (t === 'null') {
    return z.null();
  }
  return z.unknown();
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
