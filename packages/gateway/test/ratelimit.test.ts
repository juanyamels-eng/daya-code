import { describe, it, expect, vi } from 'vitest';
import { RateLimiter } from '../src/ratelimit.js';

describe('RateLimiter', () => {
  it('allows up to the limit and blocks beyond it', () => {
    const rl = new RateLimiter(60_000, 3);
    expect(rl.allow('u1')).toBe(true);
    expect(rl.allow('u1')).toBe(true);
    expect(rl.allow('u1')).toBe(true);
    expect(rl.allow('u1')).toBe(false);
    expect(rl.allow('u1')).toBe(false);
  });

  it('tracks keys independently', () => {
    const rl = new RateLimiter(60_000, 2);
    rl.allow('a');
    rl.allow('a');
    expect(rl.allow('a')).toBe(false);
    expect(rl.allow('b')).toBe(true);
  });

  it('slides the window: old hits age out and free the slot', () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(1_000, 2);
    expect(rl.allow('u')).toBe(true);
    expect(rl.allow('u')).toBe(true);
    expect(rl.allow('u')).toBe(false);

    vi.advanceTimersByTime(1_000);
    expect(rl.allow('u')).toBe(true);
    vi.useRealTimers();
  });

  it('reports remaining correctly without recording', () => {
    const rl = new RateLimiter(60_000, 3);
    expect(rl.remaining('u')).toBe(3);
    rl.allow('u');
    rl.allow('u');
    expect(rl.remaining('u')).toBe(1);
  });
});