import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';
import { readFileSafe } from './read.js';
import { writeFileSafe } from './write.js';
import { editFileSafe } from './edit.js';
import { runBash } from './bash.js';
import { globFiles } from './glob.js';
import { grepContent } from './grep.js';

export { readFileSafe, writeFileSafe, editFileSafe, runBash, globFiles, grepContent };

export const ReadFileTool: Tool = {
  definition: {
    name: 'read_file',
    description: 'Read the contents of a file at the given absolute or relative path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read.' },
        startLine: { type: 'number', description: '1-based start line offset.' },
        endLine: { type: 'number', description: '1-based end line (inclusive).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  execute: async (input, ctx) => readFileSafe(input, ctx),
};

export const WriteFileTool: Tool = {
  definition: {
    name: 'write_file',
    description:
      'Write a full file to disk. Creates parent directories. Requires permission for write actions.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or cwd-relative path.' },
        content: { type: 'string', description: 'Full file contents.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  execute: async (input, ctx) => writeFileSafe(input, ctx),
};

export const EditFileTool: Tool = {
  definition: {
    name: 'edit_file',
    description:
      'Apply a string-based replacement to a file. The old_string must occur exactly once (use all_occurrences to replace all).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        all_occurrences: { type: 'boolean', default: false },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  execute: async (input, ctx) => editFileSafe(input, ctx),
};

export const BashTool: Tool = {
  definition: {
    name: 'bash',
    description:
      'Run a shell command in the working directory. Requires user permission unless auto-allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        timeoutMs: { type: 'number', description: 'Max execution time in ms.', default: 60_000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  execute: async (input, ctx) => runBash(input, ctx),
};

export const GlobTool: Tool = {
  definition: {
    name: 'glob',
    description: 'Find files matching a glob pattern (relative to cwd).',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts".' },
        cwd: { type: 'string', description: 'Override cwd.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  execute: async (input, ctx) => globFiles(input, ctx),
};

export const GrepTool: Tool = {
  definition: {
    name: 'grep',
    description: 'Search files in cwd for a regex pattern. Returns matching file:line snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        include: { type: 'string', description: 'Glob of files to search, e.g. "*.ts".' },
        cwd: { type: 'string' },
        maxResults: { type: 'number', default: 100 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  execute: async (input, ctx) => grepContent(input, ctx),
};

export const ReadInputSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

export const WriteInputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const EditInputSchema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  all_occurrences: z.boolean().optional(),
});

export const BashInputSchema = z.object({
  command: z.string(),
  timeoutMs: z.number().int().positive().optional(),
});

export const GlobInputSchema = z.object({
  pattern: z.string(),
  cwd: z.string().optional(),
});

export const GrepInputSchema = z.object({
  pattern: z.string(),
  include: z.string().optional(),
  cwd: z.string().optional(),
  maxResults: z.number().int().positive().optional(),
});

export function defaultTools(): Tool[] {
  return [ReadFileTool, WriteFileTool, EditFileTool, BashTool, GlobTool, GrepTool];
}

export function ok(output: string, metadata?: Record<string, unknown>): ToolResult {
  return { output, metadata };
}

export function err(output: string): ToolResult {
  return { output, isError: true };
}
