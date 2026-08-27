import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Message } from '../types.js';

export interface SessionMeta {
  id: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  title?: string;
}

export interface Session {
  meta: SessionMeta;
  messages: Message[];
}

export class SessionStore {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    if (!existsSync(this.dir)) {
      await mkdir(this.dir, { recursive: true });
    }
  }

  async create(cwd: string, title?: string): Promise<Session> {
    const now = Date.now();
    const session: Session = {
      meta: { id: nanoid(10), createdAt: now, updatedAt: now, cwd, title },
      messages: [],
    };
    await this.save(session);
    return session;
  }

  async get(id: string): Promise<Session | null> {
    const file = this.filePath(id);
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as Session;
  }

  async list(): Promise<SessionMeta[]> {
    await this.init();
    const entries = await readdir(this.dir).catch(() => []);
    const out: SessionMeta[] = [];
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.dir, e), 'utf8');
        const s = JSON.parse(raw) as Session;
        out.push(s.meta);
      } catch {
        // skip corrupt
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async save(session: Session): Promise<void> {
    await this.init();
    session.meta.updatedAt = Date.now();
    const file = this.filePath(session.meta.id);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
    await writeFile(file, JSON.stringify(session, null, 2), 'utf8');
    await unlink(tmp).catch(() => undefined);
  }

  async delete(id: string): Promise<void> {
    await unlink(this.filePath(id)).catch(() => undefined);
  }

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
