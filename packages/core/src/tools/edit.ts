import { resolve, isAbsolute } from 'node:path';
import type { ToolContext, ToolResult } from '../types.js';
import { EditInputSchema, ok, err } from './index.js';

export async function editFileSafe(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = EditInputSchema.safeParse(input);
  if (!parsed.success) return err(`Invalid input: ${parsed.error.message}`);
  const { path: rawPath, old_string, new_string, all_occurrences } = parsed.data;
  const abs = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

  const decision = await ctx.permissions.check({ kind: 'edit_file', path: abs });
  if (!decision.allowed) {
    return err(`Permission denied for editing ${abs}: ${decision.reason ?? 'no reason given'}`);
  }

  const fs = await import('node:fs/promises');
  try {
    const original = await fs.readFile(abs, 'utf8');
    const occurrences = original.split(old_string).length - 1;

    if (occurrences === 0) {
      return err(`old_string not found in ${abs}`);
    }
    if (occurrences > 1 && !all_occurrences) {
      return err(
        `old_string matches ${occurrences} locations in ${abs}. Provide more context or set all_occurrences=true.`,
      );
    }

    if (ctx.requestApproval) {
      const approved = await ctx.requestApproval({
        kind: 'edit',
        path: abs,
        old_text: old_string,
        new_text: new_string,
        occurrences,
      });
      if (!approved) return err(`Edit rejected by the user: ${abs}`);
    }

    const updated = all_occurrences
      ? original.split(old_string).join(new_string)
      : original.replace(old_string, new_string);
    await fs.writeFile(abs, updated, 'utf8');
    return ok(`Edited ${abs} (${occurrences} replacement${occurrences > 1 ? 's' : ''})`, {
      path: abs,
      replacements: occurrences,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to edit ${abs}: ${msg}`);
  }
}
