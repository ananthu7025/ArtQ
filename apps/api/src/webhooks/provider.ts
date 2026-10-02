// Webhook providers (architecture.md §8.1, api.md §5). A provider verifies signatures on the RAW body, names the event,
// and maps event types to handlers. A handler re-fetches the authoritative object outside any transaction (`fetch`) and
// applies it inside the fenced webhook transaction (`apply`): event order and duplicates therefore do not matter.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';

export type InboxEvent = { id: number; provider: string; eventId: string; eventType: string; payload: unknown };

export type WebhookHandler<F = unknown> = {
  /** Network step, no transaction open. `renewed()` tells a slow fetch whether the lease is still ours. */
  fetch(ev: InboxEvent, ctx: { signal: AbortSignal }): Promise<F>;
  /** Inside the transaction between aq_webhook_begin and aq_webhook_complete. Return IGNORED when nothing applies. */
  apply(tx: Prisma.TransactionClient, fetched: F, ev: InboxEvent): Promise<'PROCESSED' | 'IGNORED' | void>;
};

export type WebhookProvider = {
  /** URL segment: POST /v1/webhooks/<slug>. */
  slug: string;
  /** Stored in webhook_events.provider. */
  name: string;
  /** null while the provider is not configured (the endpoint then answers 503 so the provider retries later). */
  verify: ((rawBody: Buffer, headers: Record<string, string | string[] | undefined>) => boolean) | null;
  eventId(headers: Record<string, string | string[] | undefined>, body: unknown): string | null;
  eventType(body: unknown): string | null;
  createdAt(body: unknown): Date | null;
  /** Event types the provider handles; anything else is recorded as IGNORED. */
  handlers: Record<string, WebhookHandler>;
};

const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** HMAC-SHA256 hex of the raw body, compared in constant time. */
export function hmacHexMatches(secret: string, rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export class NotImplementedYetError extends Error {
  constructor(what: string) { super(`${what} is not implemented yet`); this.name = 'NotImplementedYetError'; }
}

/** Events api.md §5 says the Razorpay endpoint handles. Their handlers (re-fetch + aq_apply_provider_payment / refunds) arrive in Phase 4. */
export const RAZORPAY_EVENTS = ['payment.authorized', 'payment.captured', 'payment.failed', 'order.paid', 'refund.created', 'refund.processed', 'refund.failed'] as const;

/**
 * Razorpay: `X-Razorpay-Signature` = HMAC-SHA256(rawBody, webhook secret); event id from `x-razorpay-event-id`.
 * Until Phase 4 the handled events fail (and are retried, then DEAD + WEBHOOK_DEAD): never silently ignored.
 */
export function razorpayProvider(webhookSecret: string | undefined, handlers?: Record<string, WebhookHandler>): WebhookProvider {
  const pending: WebhookHandler = {
    fetch: async (ev) => { throw new NotImplementedYetError(`Razorpay "${ev.eventType}" handling (Phase 4)`); },
    apply: async () => {},
  };
  return {
    slug: 'razorpay',
    name: 'RAZORPAY',
    verify: webhookSecret ? (raw, h) => hmacHexMatches(webhookSecret, raw, header(h, 'x-razorpay-signature')) : null,
    eventId: (h) => header(h, 'x-razorpay-event-id') ?? null,
    eventType: (b) => (typeof b === 'object' && b !== null && typeof (b as { event?: unknown }).event === 'string' ? (b as { event: string }).event : null),
    createdAt: (b) => {
      const t = typeof b === 'object' && b !== null ? (b as { created_at?: unknown }).created_at : undefined;
      return typeof t === 'number' ? new Date(t * 1000) : null;
    },
    handlers: handlers ?? Object.fromEntries(RAZORPAY_EVENTS.map((e) => [e, pending])),
  };
}
