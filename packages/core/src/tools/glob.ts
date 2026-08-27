import fg from 'fast-glob';
import { resolve, isAbsolute } from 'node:path';
import type { ToolContext, ToolResult } from '../types.js';
import { GlobInputSchema, ok, err } from './index.js';

export async function globFiles(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = GlobInputSchema.safeParse(input);
  if (!parsed.success) return err(`Invalid input: ${parsed.error.message}`);
  const { pattern, cwd: rawCwd } = parsed.data;
  const cwd = rawCwd
    ? isAbsolute(rawCwd)
      ? rawCwd
      : resolve(ctx.cwd, rawCwd)
    : ctx.cwd;

  try {
    const matches = await fg(pattern, {
      cwd,
      dot: false,
      onlyFiles: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    });
    return ok(matches.length === 0 ? '(no matches)' : matches.join('\n'), { count: matches.length });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
