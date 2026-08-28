/** In-memory sliding-window rate limiter keyed by user token. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly defaultMax = 60,
  ) {}

  /** Register a hit. Returns true if allowed, false if over the limit. */
  allow(key: string, limitPerWindow?: number): boolean {
    const max = limitPerWindow !== undefined && limitPerWindow > 0 ? limitPerWindow : this.defaultMax;
    return this.hit(key, max, true) <= max;
  }

  /** Requests still available in the current window for this key. */
  remaining(key: string, limitPerWindow?: number): number {
    const max = limitPerWindow !== undefined && limitPerWindow > 0 ? limitPerWindow : this.defaultMax;
    const active = this.hit(key, max, false);
    return Math.max(0, max - active);
  }

  /** Count (and optionally record) active hits in the current window. */
  private hit(key: string, max: number, record: boolean): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let ts = this.hits.get(key);
    if (!ts) {
      ts = [];
      this.hits.set(key, ts);
    }
    while (ts.length && ts[0]! <= cutoff) ts.shift();
    if (record) ts.push(now);
    if (ts.length === 0) this.hits.delete(key);
    return ts.length;
  }
}

export const DEFAULT_RPM = 60;

/** True when a user has used at least `fraction` of their monthly quota. */
export function quotaNear(used: number, quota: number | undefined, fraction = 0.9): boolean {
  if (quota === undefined || quota <= 0) return false;
  return used / quota >= fraction;
}
