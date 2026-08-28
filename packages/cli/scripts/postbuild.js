#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// The compiled entry lives at packages/cli/dist/index.js — not in scripts/.
const target = join(here, '..', 'dist', 'index.js');

if (existsSync(target)) {
  await chmod(target, 0o755);
}
