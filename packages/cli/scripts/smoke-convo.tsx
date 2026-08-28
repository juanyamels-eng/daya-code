import { writeFileSync } from 'node:fs';
import React from 'react';
import { render, Box, Text } from 'ink';
import { EventEmitter } from 'node:events';
import { MessageRow, DiffMeta } from '../dist/tui/App.js';
import { getTheme } from '../dist/tui/themes.js';
import { glyphs } from '../dist/tui/glyphs.js';
import { THEME_NAMES } from '../dist/tui/themes.js';

const stdout = new EventEmitter();
stdout.columns = 100;
stdout.frames = [];
stdout.write = (frame) => {
  stdout.frames.push(frame);
  stdout._lastFrame = frame;
};
stdout.lastFrame = () => stdout._lastFrame;
const stderr = new EventEmitter();
stderr.write = () => {};
const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.setEncoding = () => {};
stdin.resume = () => {};
stdin.pause = () => {};
stdin.ref = () => {};
stdin.unref = () => {};
stdin.read = () => null;

const theme = getTheme('catppuccin');
const g = glyphs();

const Demo = () => {
  const columns = stdout.columns ?? 80;
  return (
    <Box flexDirection="column">
      <Box width={columns} marginBottom={1}>
        <Box flexGrow={1}>
          <Text color={theme.text.primary}>* DAYA Code</Text>
          <Text color={theme.text.muted}>{' | v0.5.1'}</Text>
        </Box>
        <Box flexGrow={1} justifyContent="center">
          <Text color={theme.accents.build} bold>* build</Text>
          <Text color={theme.text.muted}>{'  '}</Text>
          <Text color={theme.text.muted}>o plan</Text>
        </Box>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text color={theme.text.muted}>groq | llama-3.3-70b-versatile | catppuccin</Text>
        </Box>
      </Box>

      <Box flexDirection="column" height={25} flexGrow={1}>
        <MessageRow entry={{ kind: 'system', text: 'C:\\proyecto\\mi-app' }} theme={theme} />
        <MessageRow
          entry={{ kind: 'system', text: 'arregla el bug del login', meta: '' }}
          theme={theme}
        />
        <MessageRow theme={theme} entry={{ kind: 'user', text: 'arregla el bug del login, por favor' }} />
        <MessageRow
          theme={theme}
          entry={{
            kind: 'assistant',
            text: [
              '## Diagnóstico',
              'El **token** se creaba sin expiración en `src/login.ts`. Plan:',
              '- [x] Localizar el bug',
              '- [x] Añadir `ttl` de 1 hora',
              '- [ ] Correr tests',
              '',
              '```ts',
              'const token = createToken(u, p, { ttl: 3600 });',
              '```',
              '',
              'Puedes ver el cambio en el diff de abajo *antes* de aplicarlo.',
            ].join('\n'),
          }}
        />
        <MessageRow
          theme={theme}
          entry={{
            kind: 'tool',
            text: `${g.check} bash ${g.bullet} 0.8s`,
            meta: 'cat API routes everywhere...',
          }}
        />
        <MessageRow
          theme={theme}
          entry={{
            kind: 'tool',
            text: `${g.check} edit ${g.bullet} 0.3s ${g.bullet} review`,
            meta: [
              '-linea vieja con contenido',
              '+linea nueva con contenido',
              '  contexto',
            ].join('\n'),
          }}
        />
        <DiffMeta
          theme={theme}
          text={[
            'diff --git a/src/login.ts b/src/login.ts',
            '--- a/src/login.ts',
            '+++ b/src/login.ts',
            '@@ -12,7 +12,7 @@ export function login(u, p) {',
            ' const ok = db.check(u, p);',
            '-const token = createToken(u, p);',
            '+const token = createToken(u, p, { ttl: 3600 });',
            ' return { ok, token };',
          ].join('\n')}
        />
        <MessageRow
          theme={theme}
          entry={{ kind: 'assistant', text: 'He localizado el problema: el token se creaba sin expiración. Lo he corregido en `src/login.ts` y añadido un TTL de una hora.' }}
        />
        <MessageRow
          theme={theme}
          entry={{ kind: 'tool', text: `${g.cross} npm test ${g.bullet} 12.4s`, meta: 'FAIL src/login.test.ts (3 failed)', metaColor: theme.accents.error }}
        />
        <MessageRow
          theme={theme}
          entry={{ kind: 'diag', text: `2 errors ${g.bullet} 1 warning ${g.dash} src/login.ts`, meta: `  12:5  ${g.cross} tsc  Type 'string' not assignable to type 'number'`, metaColor: theme.accents.error }}
        />
        <MessageRow
          theme={theme}
          entry={{ kind: 'system', text: `compacted ${g.dash} summarized 4, kept 2` }}
        />
        <MessageRow
          theme={theme}
          entry={{ kind: 'system', text: `${g.dots} 23 older lines ${g.dash} ↑ scroll` }}
        />
        <SpinnerLine />
      </Box>

      <Box marginTop={1}>
        <Text color={theme.accents.build}>{g.buildDot} </Text>
        <Text color={theme.text.muted}>Ask DAYA something{g.dots}</Text>
      </Box>
      <Box justifyContent="space-between" width="100%" marginTop={1}>
        <Text color={theme.accents.build}>
          running {g.bullet} 9s {g.bullet} <Text color={theme.text.muted}>ctrl+c to cancel</Text>
        </Text>
        <Text color={theme.text.muted}>
          1.2k {g.bullet} 4% ctx {g.bullet} $0.00 {g.bullet} 4 tools
        </Text>
      </Box>
    </Box>
  );
};

function SpinnerLine() {
  return (
    <Box marginTop={1}>
      <Text color={theme.text.muted}>running</Text>
    </Box>
  );
}

setTimeout(() => process.exit(0), 6000);
const instance = render(React.createElement(Demo), { stdout, stderr, stdin, debug: true, exitOnCtrlC: false, patchConsole: false });
setTimeout(() => {
  let out = '=== FRAME ===\n' + (stdout.lastFrame() ?? 'NONE');
  writeFileSync('smoke-convo.txt', out, 'utf8');
  instance.unmount();
  process.exit(0);
}, 1200);