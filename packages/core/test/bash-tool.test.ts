import { describe, it, expect } from 'vitest';
import { runBash } from '../src/tools/bash.js';
import type { ToolContext } from '../src/types.js';
import { AllowAllChecker } from '../src/permissions/checker.js';

function bashCtx(cwd: string): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    permissions: new AllowAllChecker(),
  };
}

describe('runBash', () => {
  it('captures stdout of a successful command', async () => {
    const r = await runBash({ command: 'echo hello-daya' }, bashCtx(process.cwd()));
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain('hello-daya');
  });

  it('returns an error with stderr on non-zero exit', async () => {
    const r = await runBash({ command: 'echo oops 1>&2 & exit 7' }, bashCtx(process.cwd()));
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Exit 7/);
    expect(r.output).toContain('oops');
  });

  it('kills long-running commands after timeoutMs', async () => {
    const started = Date.now();
    const r = await runBash(
      { command: 'ping 127.0.0.1 -n 60', timeoutMs: 300 },
      bashCtx(process.cwd()),
    );
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/timeout after 300ms/);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);
});