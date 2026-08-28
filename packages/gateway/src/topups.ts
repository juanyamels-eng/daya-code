import { randomBytes } from 'node:crypto';
import type { RawConfig, Topup } from './config.js';

export const TOKENS_PER_USD = 250_000;

export function topupCode(bytes = 8): string {
  return 'topup_' + randomBytes(bytes).toString('hex').slice(0, 12);
}

/** Token amount a given USD purchase should credit. */
export function tokensForUsd(usd: number): number {
  return Math.max(0, Math.floor(usd * TOKENS_PER_USD));
}

export function createTopup(raw: RawConfig, user: string, amountUsd: number, amountTokens?: number): Topup {
  const topup: Topup = {
    code: topupCode(),
    user,
    amountUsd,
    amountTokens: amountTokens ?? tokensForUsd(amountUsd),
    status: 'pending',
    ts: Date.now(),
  };
  raw.topups = raw.topups ?? [];
  raw.topups.unshift(topup);
  return topup;
}

export function listTopups(raw: RawConfig, user?: string): Topup[] {
  const all = raw.topups ?? [];
  if (user) return all.filter((t) => t.user === user);
  return all;
}

export function findTopup(raw: RawConfig, code: string): Topup | undefined {
  return (raw.topups ?? []).find((t) => t.code === code);
}

export interface ApproveResult {
  topup: Topup;
  user: string;
  previousQuota: number;
  newQuota: number;
}

/**
 * Mark a pending top-up as paid and credit its token amount to the user's
 * quota. Returns null if the code is missing or no longer pending.
 */
export function approveTopup(raw: RawConfig, code: string): ApproveResult | null {
  const topup = findTopup(raw, code);
  if (!topup || topup.status !== 'pending') return null;

  const user = (raw.users ?? []).find((u) => u.name === topup.user);
  if (!user) return null;

  const previousQuota = user.quota ?? 0;
  const newQuota = previousQuota + topup.amountTokens;
  user.quota = newQuota;
  topup.status = 'paid';
  topup.paidAt = Date.now();

  return { topup, user: topup.user, previousQuota, newQuota };
}

export function cancelTopup(raw: RawConfig, code: string): Topup | null {
  const topup = findTopup(raw, code);
  if (!topup || topup.status !== 'pending') return null;
  topup.status = 'cancelled';
  return topup;
}
