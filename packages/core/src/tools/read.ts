import { resolve, isAbsolute } from 'node:path';
import type { ToolContext, ToolResult } from '../types.js';
import { ReadInputSchema, ok, err } from './index.js';

const MAX_READ_BYTES = 10 * 1024 * 1024;

export async function readFileSafe(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = ReadInputSchema.safeParse(input);
  if (!parsed.success) return err(`Invalid input: ${parsed.error.message}`);
  const { path: rawPath, startLine, endLine } = parsed.data;
  const abs = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

  const fs = await import('node:fs/promises');
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return err(`Not a regular file: ${abs}`);
    if (stat.size > MAX_READ_BYTES) {
      return err(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Use startLine/endLine to read a range.`);
    }

    const content = await fs.readFile(abs, 'utf8');

    if (startLine || endLine) {
      const lines = content.split(/\r?\n/);
      const start = Math.max(0, (startLine ?? 1) - 1);
      const end = endLine ? Math.min(endLine, lines.length) : lines.length;
      const slice = lines.slice(start, end);
      const lineInfo = `lines ${start + 1}-${end} of ${lines.length}`;
      return ok(slice.join('\n'), { path: abs, lineInfo, totalLines: lines.length });
    }

    return ok(content, { size: stat.size, path: abs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to read ${abs}: ${msg}`);
  }
}
