import { homedir } from 'node:os';
import { join, resolve, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalMemory } from './local.js';

export interface ProjectMemory {
  memory: LocalMemory;
  namespace: string;
  dbPath: string;
}

function slug(cwd: string): string {
  const norm = normalize(resolve(cwd)).replace(/^[A-Za-z]:/, '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const hash = createHash('sha256').update(norm.toLowerCase()).digest('hex').slice(0, 10);
  const name = norm.split('/').filter(Boolean).pop() ?? 'root';
  return `${name}-${hash}`;
}

export function projectMemory(cwd: string): ProjectMemory {
  const root = process.env['DAYA_MEMORY_DIR'] ?? join(homedir(), '.daya', 'memory');
  const s = slug(cwd);
  const dbPath = join(root, `${s}.db`);
  const memory = new LocalMemory({ path: dbPath });
  const namespace = normalize(resolve(cwd)).replace(/\\/g, '/').toLowerCase();
  return { memory, namespace, dbPath };
}
