#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, 'index.js');

if (existsSync(target)) {
  await chmod(target, 0o755);
}
