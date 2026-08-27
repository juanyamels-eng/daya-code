import { writeFileSync } from 'node:fs';
import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';

const stdout = new EventEmitter();
stdout.columns = 100;
stdout.frames = [];
stdout.write = (frame) => {
  stdout.frames.push(frame);
  stdout._lastFrame = frame;
};
stdout.lastFrame = () => stdout._lastFrame;
const stderr = new EventEmitter();
stderr.frames = [];
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

const { App } = await import('../dist/tui/App.js');

process.env.DAYA_API_KEY = 'sk-test';
process.env.DAYA_MODEL = 'gpt-4o-mini';
process.env.DAYA_PROVIDER = 'openai';

setTimeout(() => process.exit(0), 6000);

const instance = render(
  React.createElement(App, {
    cwd: process.env.SMOKE_CWD ?? process.cwd(),
    sessionsDir: null,
    provider: 'openai',
    model: 'gpt-4o-mini',
  }),
  { stdout, stderr, stdin, debug: true, exitOnCtrlC: false, patchConsole: false },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);
let out = '=== LAST FRAME ===\n' + (stdout.lastFrame() ?? 'NONE') + '\n=== FRAMES COUNT ===\n' + stdout.frames.length;
writeFileSync(process.env.OUT_FILE ?? 'smoke-frame.txt', out);
instance.unmount();