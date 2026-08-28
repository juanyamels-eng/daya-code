import type { ServerResponse } from 'node:http';
import type { GatewayConfig, GatewayUser, Topup } from './config.js';
import { configFilePath, readConfigFile, writeConfigFile } from './config.js';
import { createTopup, listTopups, approveTopup, cancelTopup, tokensForUsd } from './topups.js';
import { createCheckoutSession, stripeConfigured } from './stripePay.js';
import type { Identity } from './server.js';

const TOPUP_MIN_USD = 5;
const TOPUP_MAX_USD = 500;

function isAdmin(identity: Identity | undefined): boolean {
  return Boolean(identity?.admin);
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.statusCode = status;
  res.end(JSON.stringify(obj));
}

export function handleCreateTopup(
  cfg: GatewayConfig,
  identity: Identity | undefined,
  body: unknown,
  res: ServerResponse,
): void {
  if (!identity || identity.admin) {
    return json(res, 401, { error: 'valid user API key required' });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const usd = typeof b['usd'] === 'number' ? b['usd'] : Number(b['usd']);
  if (!Number.isFinite(usd) || usd < TOPUP_MIN_USD || usd > TOPUP_MAX_USD) {
    return json(res, 400, { error: `usd must be between ${TOPUP_MIN_USD} and ${TOPUP_MAX_USD}` });
  }
  const file = configFilePath(cfg);
  const raw = readConfigFile(file);
  const topup = createTopup(raw, identity.name, usd, undefined);
  writeConfigFile(file, raw);
  cfg.users = raw.users as GatewayUser[];
  json(res, 200, {
    topup,
    tokens: topup.amountTokens,
    rate: '250k tokens / $1',
    payInstructions: `Send ${usd} USD then tell the admin to approve code ${topup.code}.`,
  });
}

export function handleListTopups(cfg: GatewayConfig, identity: Identity | undefined, res: ServerResponse): void {
  if (!isAdmin(identity)) {
    return json(res, 401, { error: 'admin key required' });
  }
  const file = configFilePath(cfg);
  const raw = readConfigFile(file);
  const topups = listTopups(raw);
  json(res, 200, { topups });
}

export function handleApproveTopup(cfg: GatewayConfig, identity: Identity | undefined, code: string, res: ServerResponse): void {
  if (!isAdmin(identity)) {
    return json(res, 401, { error: 'admin key required' });
  }
  const file = configFilePath(cfg);
  const raw = readConfigFile(file);
  const result = approveTopup(raw, code);
  if (!result) {
    return json(res, 404, { error: `topup ${code} not found or not pending` });
  }
  writeConfigFile(file, raw);
  cfg.users = raw.users as GatewayUser[];
  json(res, 200, result);
}

export function handleCancelTopup(cfg: GatewayConfig, identity: Identity | undefined, code: string, res: ServerResponse): void {
  if (!isAdmin(identity)) {
    return json(res, 401, { error: 'admin key required' });
  }
  const file = configFilePath(cfg);
  const raw = readConfigFile(file);
  const topup = cancelTopup(raw, code);
  if (!topup) {
    return json(res, 404, { error: `topup ${code} not found or not pending` });
  }
  writeConfigFile(file, raw);
  json(res, 200, { topup });
}

export function currentUserQuota(cfg: GatewayConfig, name: string): number | undefined {
  return cfg.users.find((u) => u.name === name)?.quota;
}

export async function handleStripeCheckout(
  cfg: GatewayConfig,
  identity: Identity | undefined,
  baseUrl: string,
  body: unknown,
  res: ServerResponse,
): Promise<void> {
  if (!identity || identity.admin) {
    return json(res, 401, { error: 'valid user API key required' });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const usd = typeof b['usd'] === 'number' ? b['usd'] : Number(b['usd']);
  if (!Number.isFinite(usd) || usd < TOPUP_MIN_USD || usd > TOPUP_MAX_USD) {
    return json(res, 400, { error: `usd must be between ${TOPUP_MIN_USD} and ${TOPUP_MAX_USD}` });
  }
  const file = configFilePath(cfg);
  const raw = readConfigFile(file);
  const topup = createTopup(raw, identity.name, usd, undefined);
  writeConfigFile(file, raw);
  cfg.users = raw.users as GatewayUser[];

  if (!stripeConfigured()) {
    return json(res, 200, {
      mode: 'manual',
      topup,
      tokens: topup.amountTokens,
      rate: '250k tokens / $1',
    });
  }
  const checkout = await createCheckoutSession(topup.code, usd, baseUrl);
  if (!checkout.ok) {
    return json(res, 200, {
      mode: 'manual',
      topup,
      tokens: topup.amountTokens,
      stripeError: checkout.error,
    });
  }
  json(res, 200, {
    mode: 'stripe',
    topup,
    tokens: topup.amountTokens,
    checkoutUrl: checkout.url,
  });
}

/** Approve a top-up by code after a confirmed Stripe payment. */
export function approveByCode(cfg: GatewayConfig, code: string): boolean {
  const file = configFilePath(cfg);
  const raw = readConfigFile(file);
  const result = approveTopup(raw, code);
  if (!result) return false;
  writeConfigFile(file, raw);
  cfg.users = raw.users as GatewayUser[];
  return true;
}
