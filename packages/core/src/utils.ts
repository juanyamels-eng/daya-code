import { readFile, readdir, stat, writeFile as wf } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { relative, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── Diff ───────────────────────────────────────────────────────────────────

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  content: string;
  oldLine?: number;
  newLine?: number;
}

export function computeDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const diff: DiffLine[] = [];
  let oldIdx = 0;
  let newIdx = 0;
  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (oldIdx < oldLines.length && newIdx < newLines.length) {
      if (oldLines[oldIdx] === newLines[newIdx]) {
        diff.push({ type: 'context', content: oldLines[oldIdx]!, oldLine: oldIdx + 1, newLine: newIdx + 1 });
        oldIdx++; newIdx++;
      } else {
        diff.push({ type: 'remove', content: oldLines[oldIdx]!, oldLine: oldIdx + 1 });
        diff.push({ type: 'add', content: newLines[newIdx]!, newLine: newIdx + 1 });
        oldIdx++; newIdx++;
      }
    } else if (oldIdx < oldLines.length) {
      diff.push({ type: 'remove', content: oldLines[oldIdx]!, oldLine: oldIdx + 1 });
      oldIdx++;
    } else {
      diff.push({ type: 'add', content: newLines[newIdx]!, newLine: newIdx + 1 });
      newIdx++;
    }
  }
  const lines: string[] = [];
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);
  lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
  for (const d of diff) {
    const prefix = d.type === 'add' ? '+' : d.type === 'remove' ? '-' : ' ';
    lines.push(`${prefix} ${d.content}`);
  }
  return lines.join('\n');
}

export async function computeFileDiff(filePath: string, newContent: string, cwd: string): Promise<string | null> {
  const full = filePath.startsWith('/') || filePath.includes(':\\') ? filePath : `${cwd}/${filePath}`;
  if (!existsSync(full)) {
    return `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${newContent.split('\n').length} @@\n${newContent.split('\n').map((l) => `+ ${l}`).join('\n')}`;
  }
  const old = await readFile(full, 'utf8');
  if (old === newContent) return null;
  return computeDiff(old, newContent, filePath);
}

// ─── Cost ───────────────────────────────────────────────────────────────────

const COST_TABLE: Record<string, { input: number; output: number }> = {
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'o1': { input: 15, output: 60 },
  'o1-mini': { input: 3, output: 12 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = COST_TABLE[model];
  if (!rates) return 0;
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

// ─── File Tree ──────────────────────────────────────────────────────────────

export interface FileTreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeEntry[];
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.cache', '__pycache__', '.vscode', '.idea',
  '.turbo', '.vercel', '.netlify', 'tmp', '.daya',
]);

const IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.env.local', '.env.*.local',
]);

export async function buildFileTree(dir: string, maxDepth: number = 3, currentDepth: number = 0): Promise<FileTreeEntry[]> {
  if (currentDepth >= maxDepth) return [];
  const entries: FileTreeEntry[] = [];
  try {
    const items = await readdir(dir);
    for (const item of items) {
      if (IGNORE_FILES.has(item)) continue;
      if (item.startsWith('.') && currentDepth === 0 && item !== '.') continue;
      const fullPath = `${dir}/${item}`;
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          if (IGNORE_DIRS.has(item)) continue;
          const children = await buildFileTree(fullPath, maxDepth, currentDepth + 1);
          entries.push({ name: item, path: fullPath, isDir: true, children });
        } else {
          entries.push({ name: item, path: fullPath, isDir: false });
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function formatFileTree(entries: FileTreeEntry[], prefix: string = ''): string {
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const isLast = i === entries.length - 1;
    const connector = isLast ? '\u2514 ' : '\u251c ';
    const icon = entry.isDir ? '\ud83d\udcc1 ' : '';
    lines.push(`${prefix}${connector}${icon}${entry.name}`);
    if (entry.children && entry.children.length > 0) {
      const childPrefix = prefix + (isLast ? '    ' : '\u2502   ');
      lines.push(formatFileTree(entry.children, childPrefix));
    }
  }
  return lines.join('\n');
}

// ─── Git Commit Message Generation ──────────────────────────────────────────

export async function getGitDiff(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--cached'], { cwd, timeout: 5000 });
    return stdout || null;
  } catch {
    return null;
  }
}

export async function getGitStatus(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd, timeout: 5000 });
    return stdout;
  } catch {
    return '';
  }
}

export function generateCommitMessage(diff: string): string {
  const added = (diff.match(/^\+[^+]/gm) || []).length;
  const removed = (diff.match(/^-[^-]/gm) || []).length;
  const files = [...new Set((diff.match(/^diff --git a\/(.+) b\//gm) || []).map((l) => l.replace(/^diff --git a\//, '').replace(/ b\//, '')))];

  const parts: string[] = [];

  if (files.length <= 3) {
    const names = files.map((f) => f.split('/').pop() ?? f);
    parts.push(names.join(', '));
  } else {
    parts.push(`${files.length} files`);
  }

  if (added > 0 && removed === 0) {
    parts.push(`add ${added} lines`);
  } else if (removed > 0 && added === 0) {
    parts.push(`remove ${removed} lines`);
  } else if (added > 0 && removed > 0) {
    parts.push(`modify ${added + removed} lines`);
  }

  const hasTest = files.some((f) => f.includes('test') || f.includes('spec'));
  const hasConfig = files.some((f) => f.includes('config') || f.includes('.json') || f.includes('.yml'));
  const hasReadme = files.some((f) => f.toLowerCase().includes('readme'));

  let prefix = 'chore';
  if (hasTest) prefix = 'test';
  else if (hasConfig) prefix = 'chore';
  else if (hasReadme) prefix = 'docs';
  else if (added > removed * 3) prefix = 'feat';
  else if (removed > added * 3) prefix = 'refactor';
  else prefix = 'fix';

  return `${prefix}: ${parts.join(' — ')}`;
}

// ─── Checkpoint System ──────────────────────────────────────────────────────

export interface Checkpoint {
  id: string;
  label: string;
  timestamp: number;
  messages: import('./types.js').Message[];
  mode: string;
  filesSnapshot: Map<string, string>;
}

export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];
  private counter = 0;

  async save(
    label: string,
    messages: import('./types.js').Message[],
    mode: string,
    cwd: string,
    trackedFiles: Set<string>,
  ): Promise<Checkpoint> {
    const filesSnapshot = new Map<string, string>();
    for (const filePath of trackedFiles) {
      try {
        const content = await readFile(filePath, 'utf8');
        filesSnapshot.set(filePath, content);
      } catch {
        // file deleted or inaccessible
      }
    }

    const cp: Checkpoint = {
      id: `cp-${++this.counter}`,
      label,
      timestamp: Date.now(),
      messages: JSON.parse(JSON.stringify(messages)),
      mode,
      filesSnapshot,
    };
    this.checkpoints.push(cp);
    return cp;
  }

  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  get(id: string): Checkpoint | undefined {
    return this.checkpoints.find((c) => c.id === id);
  }

  getLatest(): Checkpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  restore(id: string): { messages: import('./types.js').Message[]; mode: string } | undefined {
    const cp = this.get(id);
    if (!cp) return undefined;
    return {
      messages: JSON.parse(JSON.stringify(cp.messages)),
      mode: cp.mode,
    };
  }

  async restoreFiles(id: string): Promise<void> {
    const cp = this.get(id);
    if (!cp) return;
    for (const [filePath, content] of cp.filesSnapshot) {
      try {
        await wf(filePath, content, 'utf8');
      } catch {
        // ignore
      }
    }
  }
}

// ─── File Watcher ───────────────────────────────────────────────────────────

export interface FileChange {
  type: 'created' | 'modified' | 'deleted';
  path: string;
  timestamp: number;
}

export class FileWatcher {
  private watched = new Map<string, number>();
  private changes: FileChange[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private cwd: string, private intervalMs: number = 2000) {}

  track(filePath: string): void {
    try {
      const s = statSync(filePath);
      this.watched.set(filePath, s.mtimeMs);
    } catch {
      this.watched.set(filePath, 0);
    }
  }

  trackMany(files: Set<string>): void {
    for (const f of files) this.track(f);
  }

  start(onChange: (changes: FileChange[]) => void): void {
    this.timer = setInterval(() => {
      const newChanges: FileChange[] = [];
      for (const [filePath, lastMtime] of this.watched) {
        try {
          const s = statSync(filePath);
          if (s.mtimeMs > lastMtime) {
            newChanges.push({ type: 'modified', path: filePath, timestamp: Date.now() });
            this.watched.set(filePath, s.mtimeMs);
          }
        } catch {
          newChanges.push({ type: 'deleted', path: filePath, timestamp: Date.now() });
          this.watched.delete(filePath);
        }
      }
      if (newChanges.length > 0) {
        this.changes.push(...newChanges);
        onChange(newChanges);
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getChanges(): FileChange[] {
    return [...this.changes];
  }

  clearChanges(): void {
    this.changes = [];
  }
}

// ─── LSP Diagnostics ────────────────────────────────────────────────────────

export interface LspDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
}

export async function getDiagnostics(filePath: string): Promise<LspDiagnostic[]> {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const diagnostics: LspDiagnostic[] = [];

  if (ext === 'ts' || ext === 'tsx') {
    try {
      const { stdout } = await execFileAsync('npx', ['tsc', '--noEmit', '--pretty', 'false', filePath], {
        timeout: 15000,
        cwd: process.cwd(),
      });
      for (const line of stdout.split('\n')) {
        const match = line.match(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/);
        if (match) {
          diagnostics.push({
            file: match[1]!,
            line: parseInt(match[2]!),
            column: parseInt(match[3]!),
            severity: match[4] === 'error' ? 'error' : 'warning',
            message: match[6]!,
            source: match[5]!,
          });
        }
      }
    } catch {
      // tsc not available or failed
    }
  }

  if (ext === 'js' || ext === 'jsx' || ext === 'ts' || ext === 'tsx') {
    try {
      const { stdout } = await execFileAsync('npx', ['eslint', '--format', 'json', filePath], {
        timeout: 15000,
        cwd: process.cwd(),
      });
      const results = JSON.parse(stdout) as Array<{ messages: Array<{ line: number; column: number; severity: number; message: string; ruleId: string }> }>;
      for (const result of results) {
        for (const msg of result.messages) {
          diagnostics.push({
            file: filePath,
            line: msg.line,
            column: msg.column,
            severity: msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info',
            message: msg.message,
            source: msg.ruleId ?? 'eslint',
          });
        }
      }
    } catch {
      // eslint not available
    }
  }

  return diagnostics;
}

// ─── Prompt Cache Optimization ──────────────────────────────────────────────

export function optimizeSystemPrompt(system: string): string {
  const sections = system.split('\n\n');
  const stable: string[] = [];
  const dynamic: string[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (
      trimmed.includes('[Context compacted') ||
      trimmed.includes('Current mode:') ||
      trimmed.includes('Relevant memories')
    ) {
      dynamic.push(section);
    } else {
      stable.push(section);
    }
  }

  return stable.join('\n\n');
}

// ─── Rate Limit Tracking ────────────────────────────────────────────────────

export interface RateLimitState {
  remaining: number | null;
  limit: number | null;
  resetMs: number | null;
  retryAfterMs: number | null;
}

export function parseRateLimitHeaders(headers: Record<string, string>): RateLimitState {
  return {
    remaining: headers['x-ratelimit-remaining'] ? parseInt(headers['x-ratelimit-remaining']) : null,
    limit: headers['x-ratelimit-limit'] ? parseInt(headers['x-ratelimit-limit']) : null,
    resetMs: headers['x-ratelimit-reset'] ? parseInt(headers['x-ratelimit-reset']) * 1000 : null,
    retryAfterMs: headers['retry-after'] ? parseInt(headers['retry-after']) * 1000 : null,
  };
}

export function formatRateLimit(state: RateLimitState): string | null {
  if (state.retryAfterMs) {
    return `Rate limited — retry after ${Math.ceil(state.retryAfterMs / 1000)}s`;
  }
  if (state.remaining !== null && state.limit !== null) {
    const pct = Math.round((state.remaining / state.limit) * 100);
    const resetStr = state.resetMs ? ` (resets ${new Date(state.resetMs).toLocaleTimeString()})` : '';
    return `Rate limit: ${state.remaining}/${state.limit} remaining (${pct}%)${resetStr}`;
  }
  return null;
}
