import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalMemory } from './local.js';

const instances = new Map<string, LocalMemory>();

export interface MemoryStoreOptions {
  path?: string;
  namespace?: string;
}

export function defaultMemoryPath(): string {
  return join(homedir(), '.daya', 'memory.db');
}

export function getMemoryStore(opts: MemoryStoreOptions = {}): LocalMemory {
  const path = opts.path ?? defaultMemoryPath();
  let store = instances.get(path);
  if (!store) {
    store = new LocalMemory({ path });
    instances.set(path, store);
  }
  return store;
}

export function closeAllMemoryStores(): void {
  for (const s of instances.values()) s.close();
  instances.clear();
}

export function deriveNamespace(cwd: string, explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  return cwd.replace(/\\/g, '/').toLowerCase();
}
