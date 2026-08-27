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
      <Box justifyContent="space-between" width="100%">
        <Text color={theme.text.muted}>{g.brand} DAYA Code {g.bullet} v0.5.0</Text>
        <Text color={theme.text.muted}>groq {g.bullet} llama-3.3-70b-versatile {g.bullet} catppuccin</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={theme.text.muted}>{g.hairline.repeat(Math.max(40, columns - 1))}</Text>
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
            kind: 'tool',
            text: `${g.check} bash ${g.bullet} 0.8s`,
            meta: 'cat API routes everywhere...',
          }}
        />
        <MessageRow
          theme={theme}
          entry={{
            kind: 'tool',
            text: `${g.check} edit ${g.bullet} 0.3s`,
            meta: [
              'diff --git a/src/login.ts b/src/login.ts',
              '--- a/src/login.ts',
              '+++ b/src/login.ts',
              '@@ -12,7 +12,7 @@ export function login(u, p) {',
              ' const ok = db.check(u, p);',
              '-const token = createToken(u, p);',
              '+const token = createToken(u, p, { ttl: 3600 });',
              ' return { ok, token };',
            ].join('\n'),
          }}
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
        <SpinnerLine />
      </Box>

      <Box marginTop={1}>
        <Text color={theme.accents.build}>{g.buildDot} </Text>
        <Text color={theme.text.muted}>Ask DAYA something{g.dots}</Text>
      </Box>
      <Box justifyContent="space-between" width="100%" marginTop={1}>
        <Text color={theme.accents.build}>
          running {g.bullet} <Text color={theme.text.muted}>ctrl+c to cancel</Text>
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