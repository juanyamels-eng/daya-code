import { resolve, isAbsolute } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { ToolContext, ToolResult } from '../types.js';
import { GrepInputSchema, ok, err } from './index.js';

export async function grepContent(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = GrepInputSchema.safeParse(input);
  if (!parsed.success) return err(`Invalid input: ${parsed.error.message}`);
  const { pattern, include, cwd: rawCwd, maxResults = 100 } = parsed.data;
  const cwd = rawCwd ? (isAbsolute(rawCwd) ? rawCwd : resolve(ctx.cwd, rawCwd)) : ctx.cwd;

  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    return err(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
  }

  const includeRe = include ? globToRegex(include) : null;

  const matches: string[] = [];
  try {
    await walk(cwd, async (file) => {
      if (includeRe && !includeRe.test(file)) return;
      if (matches.length >= maxResults) return;
      const content = await readFile(file, 'utf8').catch(() => null);
      if (content === null) return;
      const lines = content.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (matches.length >= maxResults) return;
        if (re.test(line)) {
          matches.push(`${file}:${i + 1}:${line}`);
          re.lastIndex = 0;
        }
      });
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  return ok(matches.length === 0 ? '(no matches)' : matches.join('\n'), { count: matches.length });
}

async function walk(dir: string, onFile: (file: string) => Promise<void>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(full, onFile);
    } else if (entry.isFile()) {
      await onFile(full);
    }
  }
}

function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      re += '.*';
    } else if (ch === '?') {
      re += '.';
    } else if (ch === '.') {
      re += '\\.';
    } else if (ch === '{') {
      re += '(?:';
    } else if (ch === '}') {
      re += ')';
    } else if (ch === ',' && glob[i - 1] === '{') {
      continue;
    } else if (ch === ',') {
      re += '|';
    } else if ('+^${}()|[]\\'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp(re);
}
