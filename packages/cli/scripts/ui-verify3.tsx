import { writeFileSync } from 'node:fs';
import React from 'react';
import { render } from 'ink-testing-library';
import { MessageRow } from '../src/tui/App.js';
import { getTheme } from '../src/tui/themes.js';

const theme = getTheme('catppuccin');
const out: string[] = [];

const diffMeta = [
  'diff --git a/src/login.ts b/src/login.ts',
  '--- a/src/login.ts',
  '+++ b/src/login.ts',
  '@@ -12,7 +12,7 @@ export function login(u, p) {',
  ' const ok = db.check(u, p);',
  '-const token = createToken(u, p);',
  '+const token = createToken(u, p, { ttl: 3600 });',
  ' return { ok, token };',
].join('\n');

const fileOut = [
  'const token = createToken(u, p, { ttl: 3600 });',
  'const safe = sanitize(input);',
  'return { ok: true, token };',
  '',
  'missing error handling for empty users',
].join('\n');

const Demo = () => (
  <>
    <MessageRow entry={{ kind: 'user', text: 'arregla el bug del login, por favor' }} theme={theme} />
    <MessageRow entry={{ kind: 'assistant', text: '## Diagnóstico\n- [x] localizar\n- [ ] tests' }} theme={theme} />
    <MessageRow entry={{ kind: 'tool', text: 'ok edit · 0.3s', meta: diffMeta }} theme={theme} />
    <MessageRow entry={{ kind: 'tool', text: 'ok read_file · 0.4s', title: 'read_file', meta: fileOut }} theme={theme} />
    <MessageRow entry={{ kind: 'diff', text: 'commit preview — fix login ttl', meta: diffMeta }} theme={theme} />
  </>
);
const { lastFrame } = render(React.createElement(Demo));
out.push('=== FRAME ===\n' + (lastFrame() ?? 'NONE'));

writeFileSync('ui-verify3.txt', out.join('\n'), 'utf8');
console.log('written');
process.exit(0);