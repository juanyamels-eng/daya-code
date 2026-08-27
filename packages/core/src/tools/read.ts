import { resolve, isAbsolute } from 'node:path';
import type { ToolContext, ToolResult } from '../types.js';
import { ReadInputSchema, ok, err } from './index.js';

export async function readFileSafe(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = ReadInputSchema.safeParse(input);
  if (!parsed.success) return err(`Invalid input: ${parsed.error.message}`);
  const { path: rawPath, startLine, endLine } = parsed.data;
  const abs = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

  const fs = await import('node:fs/promises');
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return err(`Not a regular file: ${abs}`);

    if (startLine || endLine) {
      const fh = await fs.open(abs, 'r');
      try {
        const start = (startLine ?? 1) - 1;
        const length = (endLine ?? Infinity) - start;
        const buf = Buffer.alloc(Math.min(stat.size, length * 200));
        await fh.read(buf, 0, buf.length, start);
        const text = buf.toString('utf8');
        return ok(text);
      } finally {
        await fh.close();
      }
    }

    const content = await fs.readFile(abs, 'utf8');
    return ok(content, { size: stat.size, path: abs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to read ${abs}: ${msg}`);
  }
}
