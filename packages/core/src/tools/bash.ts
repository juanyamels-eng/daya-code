import { spawn } from 'node:child_process';
import type { ToolContext, ToolResult } from '../types.js';
import { BashInputSchema, ok, err } from './index.js';

const MAX_BUFFER = 1024 * 1024;

export async function runBash(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = BashInputSchema.safeParse(input);
  if (!parsed.success) return err(`Invalid input: ${parsed.error.message}`);
  const { command, timeoutMs = 60_000 } = parsed.data;

  const decision = await ctx.permissions.check({ kind: 'bash', command });
  if (!decision.allowed) {
    return err(`Permission denied for command: ${command} (${decision.reason ?? 'no reason given'})`);
  }

  return new Promise<ToolResult>((resolveP) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd: ctx.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      truncated = true;
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER) {
        const room = MAX_BUFFER - stdout.length;
        stdout += chunk.toString('utf8').slice(0, room);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER) {
        const room = MAX_BUFFER - stderr.length;
        stderr += chunk.toString('utf8').slice(0, room);
      }
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolveP(err(`Spawn error: ${e.message}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim();
      const note = truncated ? `\n[killed: timeout after ${timeoutMs}ms]` : '';
      if (code === 0) {
        resolveP(ok(out + note, { exitCode: 0, signal }));
      } else {
        resolveP(err(`Exit ${code}${signal ? ` (${signal})` : ''}\n${out}${note}`));
      }
    });
  });
}
