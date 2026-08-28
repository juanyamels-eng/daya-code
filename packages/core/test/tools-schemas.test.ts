import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { jsonSchema } from 'ai';
import { defaultTools } from '../src/tools/index.js';

// Regression: the AI SDK crashes with "Cannot read properties of undefined
// (reading 'typeName')" when a tool ships a plain JSON Schema object instead
// of a zod schema (zod-to-json-schema walks _def). Real providers (ollama,
// OpenAI, Anthropic, ...) hit this path via buildToolsObject; the mock
// provider never did. Every base tool must convert without throwing.
describe('tool schemas through the AI SDK', () => {
  for (const tool of defaultTools()) {
    it(`converts ${tool.definition.name} inputSchema to an AI SDK Schema`, () => {
      const schema = tool.definition.inputSchema as unknown;
      const parameters = schema instanceof z.ZodType ? schema : jsonSchema(schema as never);
      const s = parameters as { jsonSchema?: unknown };
      expect(s.jsonSchema).toBeDefined();
      expect((s.jsonSchema as { type?: string }).type).toBe('object');
    });
  }
});