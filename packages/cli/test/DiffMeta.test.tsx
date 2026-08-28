import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { DiffMeta } from '../src/tui/App.js';
import { getTheme } from '../src/tui/themes.js';

describe('DiffMeta', () => {
  const theme = getTheme('daya');

  const renderDiff = (text: string, forced?: string) => {
    const { lastFrame } = render(React.createElement(DiffMeta, { text, theme, forced }));
    return lastFrame();
  };

  it('renders diff --git header with +N −M tally', () => {
    const text = `diff --git a/src/login.ts b/src/login.ts
--- a/src/login.ts
+++ b/src/login.ts
@@ -12,7 +12,7 @@ export function login(u, p) {
 const ok = db.check(u, p);
-const token = createToken(u, p);
+const token = createToken(u, p, { ttl: 3600 });
+const salt = nanoid(8);`;
    const frame = renderDiff(text);
    expect(frame).toContain('diff --git a/src/login.ts b/src/login.ts');
    expect(frame).toContain('+2');
    expect(frame).toContain('-1');
  });

  it('handles forced color correctly', () => {
    const text = '+ [write] const x = 1;';
    const frame = renderDiff(text, theme.accents.success);
    expect(frame).toContain('[write]');
  });

  it('renders blank diff gracefully', () => {
    const frame = renderDiff('');
    expect(typeof frame).toBe('string');
  });

  it('renders code block with line numbers', () => {
    const text = `export function login(u, p) {
  const ok = db.check(u, p);
  return createToken(u, p, { ttl: 3600 });
}`;
    const frame = renderDiff(text);
    expect(frame).toContain('export function login');
  });
});