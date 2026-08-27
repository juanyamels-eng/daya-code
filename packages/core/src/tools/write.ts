import { resolve, isAbsolute, dirname } from 'node:path';
import type { ToolContext, ToolResult } from '../types.js';
import { WriteInputSchema, ok, err } from './index.js';

export async function writeFileSafe(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = WriteInputSchema.safeParse(input);
  if (!parsed.success) return err(`Invalid input: ${parsed.error.message}`);
  const { path: rawPath, content } = parsed.data;
  const abs = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

  const decision = await ctx.permissions.check({ kind: 'write_file', path: abs });
  if (!decision.allowed) {
    return err(`Permission denied for writing ${abs}: ${decision.reason ?? 'no reason given'}`);
  }

  const fs = await import('node:fs/promises');
  try {
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return ok(`Wrote ${content.length} bytes to ${abs}`, { path: abs, bytes: content.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to write ${abs}: ${msg}`);
  }
}
