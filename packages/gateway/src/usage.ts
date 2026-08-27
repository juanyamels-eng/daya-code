import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UsageRecord {
  token: string;
  name: string;
  model: string;
  upstream: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  ts: number;
}

export class UsageStore {
  private sums = new Map<string, { prompt: number; completion: number }>();
  private loaded = false;

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded || !existsSync(this.file)) return;
    const now = Date.now();
    const monthStart = new Date(now);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const start = monthStart.getTime();
    const content = readFileSync(this.file, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as UsageRecord;
        if (rec.ts >= start) {
          const s = this.sums.get(rec.token) ?? { prompt: 0, completion: 0 };
          s.prompt += rec.promptTokens;
          s.completion += rec.completionTokens;
          this.sums.set(rec.token, s);
        }
      } catch {
        /* ignore corrupt lines */
      }
    }
    this.loaded = true;
  }

  monthTokens(token: string): number {
    this.load();
    const s = this.sums.get(token);
    return s ? s.prompt + s.completion : 0;
  }

  record(rec: UsageRecord): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(rec) + '\n', 'utf8');
    const s = this.sums.get(rec.token) ?? { prompt: 0, completion: 0 };
    s.prompt += rec.promptTokens;
    s.completion += rec.completionTokens;
    this.sums.set(rec.token, s);
  }
}