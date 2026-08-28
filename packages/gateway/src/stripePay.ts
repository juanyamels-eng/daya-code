import Stripe from 'stripe';

export function stripeConfigured(): boolean {
  return Boolean(process.env['STRIPE_SECRET_KEY']);
}

function client(): Stripe | null {
  const key = process.env['STRIPE_SECRET_KEY'];
  return key ? new Stripe(key) : null;
}

export interface CheckoutResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/** Create a Stripe Checkout Session for a variable USD amount. */
export async function createCheckoutSession(
  topupCode: string,
  amountUsd: number,
  baseUrl: string,
): Promise<CheckoutResult> {
  const s = client();
  if (!s) return { ok: false, error: 'Stripe not configured' };
  try {
    const session = await s.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: topupCode,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(amountUsd * 100),
            product_data: { name: 'DAYA Code tokens' },
          },
        },
      ],
      success_url: `${baseUrl}/portal?paid=1`,
      cancel_url: `${baseUrl}/portal?cancel=1`,
    });
    return { ok: true, url: session.url ?? undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'stripe error' };
  }
}

export type WebhookOutcome = 'ok' | 'ignored' | 'invalid' | 'unconfigured';

/**
 * Verify the Stripe signature and, on a successful checkout, approve the
 * top-up referenced by the session's client_reference_id.
 */
export function handleStripeWebhook(
  payload: string,
  signature: string | undefined,
  approve: (code: string) => boolean,
): WebhookOutcome {
  const secret = process.env['STRIPE_WEBHOOK_SECRET'];
  if (!secret) return 'unconfigured';
  const s = client();
  if (!s) return 'unconfigured';
  let event: Stripe.Event;
  try {
    event = s.webhooks.constructEvent(payload, signature ?? '', secret);
  } catch {
    return 'invalid';
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as { client_reference_id?: string };
    if (session.client_reference_id) {
      approve(session.client_reference_id);
      return 'ok';
    }
  }
  return 'ignored';
}
