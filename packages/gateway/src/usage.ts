import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
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
  private sums = new Map<string, { prompt: number; completion: number; cost: number; requests: number }>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
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
          const s = this.sums.get(rec.token) ?? { prompt: 0, completion: 0, cost: 0, requests: 0 };
          s.prompt += rec.promptTokens;
          s.completion += rec.completionTokens;
          s.cost += rec.costUsd;
          s.requests += 1;
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

  userStats(token: string): { monthTokens: number; monthCostUsd: number; requests: number } {
    this.load();
    const s = this.sums.get(token);
    return s
      ? { monthTokens: s.prompt + s.completion, monthCostUsd: s.cost, requests: s.requests }
      : { monthTokens: 0, monthCostUsd: 0, requests: 0 };
  }

  record(rec: UsageRecord): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // Persist asynchronously but strictly serialized; the in-memory sums stay
    // authoritative for quota decisions within this process. A disk failure
    // must not break request handling.
    this.writeChain = this.writeChain
      .then(() => appendFile(this.file, JSON.stringify(rec) + '\n', 'utf8'))
      .catch((e) => {
        process.stderr.write(
          `[gateway] usage persistence failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      });
    const s = this.sums.get(rec.token) ?? { prompt: 0, completion: 0, cost: 0, requests: 0 };
    s.prompt += rec.promptTokens;
    s.completion += rec.completionTokens;
    s.cost += rec.costUsd;
    s.requests += 1;
    this.sums.set(rec.token, s);
  }

  /** Await any pending persistence writes (e.g. during graceful shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }
}