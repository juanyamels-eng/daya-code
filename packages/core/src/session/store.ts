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

  async search(query: string): Promise<SessionMeta[]> {
    const all = await this.list();
    const q = query.toLowerCase();
    return all.filter((meta) => {
      if (meta.id.toLowerCase().includes(q)) return true;
      if (meta.title?.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  async searchContent(query: string): Promise<SessionMeta[]> {
    const all = await this.list();
    const q = query.toLowerCase();
    const matches: SessionMeta[] = [];
    for (const meta of all) {
      try {
        const session = await this.get(meta.id);
        if (!session) continue;
        const hasMatch = session.messages.some(
          (m) => m.content.toLowerCase().includes(q),
        );
        if (hasMatch) matches.push(meta);
      } catch {
        // skip
      }
    }
    return matches;
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

  async exportMarkdown(session: Session): Promise<string> {
    const lines: string[] = [];
    lines.push(`# DAYA Session: ${session.meta.id}`);
    lines.push(`Date: ${new Date(session.meta.createdAt).toLocaleString()}`);
    lines.push(`Directory: ${session.meta.cwd}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    for (const msg of session.messages) {
      if (msg.role === 'system') continue;
      if (msg.role === 'user') {
        lines.push(`## You`);
        lines.push(msg.content);
        lines.push('');
      } else if (msg.role === 'assistant') {
        lines.push(`## DAYA`);
        lines.push(msg.content);
        if (msg.toolCalls) {
          lines.push('');
          for (const tc of msg.toolCalls) {
            lines.push(`> Tool: \`${tc.name}\` — \`${JSON.stringify(tc.input).slice(0, 120)}\``);
          }
        }
        lines.push('');
      } else if (msg.role === 'tool') {
        // skip raw tool output in export
      }
    }
    return lines.join('\n');
  }

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
