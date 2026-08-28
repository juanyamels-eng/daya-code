import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// We use a structural type for the SQLite handle to avoid static resolution of
// the `node:sqlite` specifier (Vite SSR otherwise tries to pre-bundle it and
// fails on Node versions that don't expose it). At runtime we always await
// the dynamic import before touching the db.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDb = any;

export interface LocalMemoryOptions {
  path: string;
}

export interface LocalMemoryEntry {
  id: number;
  namespace: string;
  key: string;
  value: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  expiresAt: number | null;
}

export interface LocalMemoryQueryHit {
  key: string;
  value: string;
  score: number;
  metadata: Record<string, unknown> | null;
}

type Db = SqliteDb;
let sqliteModulePromise: Promise<SqliteDb> | null = null;
async function loadSqlite(): Promise<SqliteDb> {
  if (!sqliteModulePromise) {
    // process.getBuiltinModule avoids Vite/Vitest SSR transform issues with
    // the experimental `node:sqlite` built-in (available on Node ≥22).
    const gbn = (globalThis.process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    if (gbn) {
      sqliteModulePromise = Promise.resolve(gbn('node:sqlite') as SqliteDb);
    } else {
      // Fallback for runtimes where getBuiltinModule is not available.
      const spec = 'node' + ':sqlite';
      sqliteModulePromise = import(/* @vite-ignore */ spec) as Promise<unknown> as Promise<SqliteDb>;
    }
  }
  return sqliteModulePromise;
}

function toNumber(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

function buildSchema(): string {
  return `
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      UNIQUE(namespace, key)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory(namespace);
    CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory(expires_at);
  `;
}

function buildFtsSchema(): string {
  return `
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      key, value, content='memory', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
      INSERT INTO memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
    END;
  `;
}

export class LocalMemory {
  private db: Db | null = null;
  private ftsAvailable = true;
  private readonly path: string;

  constructor(opts: LocalMemoryOptions) {
    this.path = opts.path;
    mkdirSync(dirname(opts.path), { recursive: true });
  }

  private async open(): Promise<Db> {
    if (this.db) return this.db;
    const sqlite = await loadSqlite();
    const { DatabaseSync } = sqlite;
    // Ensure parent directory exists (Vitest forks may have a different cwd).
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path);
    db.exec(buildSchema());
    try {
      db.exec(buildFtsSchema());
    } catch {
      this.ftsAvailable = false;
    }
    this.db = db;
    return db;
  }

  async upsert(entry: Omit<LocalMemoryEntry, 'id' | 'createdAt'> & { createdAt?: number }): Promise<{ id: number; updated: boolean }> {
    const db = await this.open();
    const now = entry.createdAt ?? Date.now();
    const existing = db
      .prepare('SELECT id FROM memory WHERE namespace = ? AND key = ?')
      .get(entry.namespace, entry.key) as { id: number } | undefined;
    if (existing) {
      db.prepare('UPDATE memory SET value = ?, metadata = ?, created_at = ?, expires_at = ? WHERE id = ?').run(
        entry.value,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        now,
        entry.expiresAt,
        existing.id,
      );
      return { id: existing.id, updated: true };
    }
    const info = db
      .prepare('INSERT INTO memory (namespace, key, value, metadata, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        entry.namespace,
        entry.key,
        entry.value,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        now,
        entry.expiresAt,
      );
    return { id: toNumber(info.lastInsertRowid), updated: false };
  }

  async get(namespace: string, key: string): Promise<LocalMemoryEntry | null> {
    const db = await this.open();
    await this.purgeExpired();
    const row = db
      .prepare(
        'SELECT id, namespace, key, value, metadata, created_at as createdAt, expires_at as expiresAt FROM memory WHERE namespace = ? AND key = ?',
      )
      .get(namespace, key) as unknown as MemoryRow | undefined;
    return row ? toEntry(row) : null;
  }

  async list(namespace: string, limit = 50): Promise<LocalMemoryEntry[]> {
    const db = await this.open();
    await this.purgeExpired();
    const rows = db
      .prepare(
        'SELECT id, namespace, key, value, metadata, created_at as createdAt, expires_at as expiresAt FROM memory WHERE namespace = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(namespace, limit) as unknown as MemoryRow[];
    return rows.map(toEntry);
  }

  async query(namespace: string, queryStr: string, topK = 5): Promise<LocalMemoryQueryHit[]> {
    try {
      return await this.queryInternal(namespace, queryStr, topK);
    } catch {
      // If the db handle got into an invalid state, reopen and retry once.
      this.db = null;
      try {
        return await this.queryInternal(namespace, queryStr, topK);
      } catch {
        return [];
      }
    }
  }

  private async queryInternal(namespace: string, queryStr: string, topK: number): Promise<LocalMemoryQueryHit[]> {
    const db = await this.open();
    await this.purgeExpired();
    if (this.ftsAvailable) {
      try {
        const rows = db
          .prepare(
            `SELECT m.key, m.value, m.metadata,
                    bm25(memory_fts) AS score
               FROM memory_fts f
               JOIN memory m ON m.id = f.rowid
              WHERE memory_fts MATCH ? AND m.namespace = ? AND (m.expires_at IS NULL OR m.expires_at > ?)
              ORDER BY score
              LIMIT ?`,
          )
          .all(buildFtsQuery(queryStr), namespace, Date.now(), topK) as unknown as Array<{ key: string; value: string; metadata: string | null; score: number }>;
        return rows.map((r) => ({
          key: r.key,
          value: r.value,
          metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
          score: Number.isFinite(r.score) ? r.score : 0,
        }));
      } catch {
        this.ftsAvailable = false;
      }
    }
    const like = `%${queryStr.replace(/[%_]/g, '\\$&')}%`;
    const rows = db
      .prepare(
        `SELECT key, value, metadata, 0 AS score
           FROM memory
          WHERE namespace = ? AND (key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(namespace, like, like, Date.now(), topK) as unknown as Array<{ key: string; value: string; metadata: string | null; score: number }>;
    return rows.map((r) => ({
      key: r.key,
      value: r.value,
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
      score: Number.isFinite(r.score) ? r.score : 0,
    }));
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    const db = await this.open();
    await this.purgeExpired();
    const info = db.prepare('DELETE FROM memory WHERE namespace = ? AND key = ?').run(namespace, key);
    return toNumber(info.changes) > 0;
  }

  async purgeExpired(): Promise<number> {
    const db = await this.open();
    const info = db
      .prepare('DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(Date.now());
    return toNumber(info.changes);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

interface MemoryRow {
  id: number;
  namespace: string;
  key: string;
  value: string;
  metadata: string | null;
  createdAt: number;
  expiresAt: number | null;
}

function toEntry(row: MemoryRow): LocalMemoryEntry {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    value: row.value,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function buildFtsQuery(input: string): string {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `${t}*`).join(' ');
}
