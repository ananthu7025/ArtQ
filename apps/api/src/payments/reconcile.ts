// Payment background jobs (task 4.9; architecture.md §7.3–7.4, database.md §8.2–8.3). Every money change still goes
// through aq_apply_provider_payment / aq_release_unpaid_order; these jobs only decide WHEN to look at Razorpay.
//   payments.reconcile-attempts (1 min): stuck attempts (CREATING/PROVIDER_UNKNOWN > 60 s) → recover by receipt;
//     open attempts of pending orders → apply any authorized/captured payment; authorized > 15 min → capture (re-fetch
//     decides); UNLINKED payments whose provider order is now mapped → re-fetch and apply (binds once).
//   orders.expire-pending (1 min): pre-expiry check of every attempt with Razorpay, then aq_release_unpaid_order.
//     An order whose check could not run is not expired this round (never expire money we have not looked at).
//   payments.reconcile-daily: yesterday's Razorpay payments all go through apply (missing, refunded-before-apply →
//     VOID/HELD, provider refunds above ArtQ's counted ones → RECON_MISMATCH); refunds unknown to ArtQ → RECON_MISMATCH.
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { CheckoutService } from '../checkout/initiate.js';
import * as fn from '../db/functions.js';
import { applySnapshot } from './apply.js';
import { ProviderError, type PaymentProvider, type ProviderPayment } from './razorpay.js';

export type ReconcileDeps = { prisma: PrismaClient; provider: PaymentProvider; checkout: CheckoutService; log: Logger; now?: () => Date };
export const STUCK_AFTER_MS = 60_000;
export const CAPTURE_AFTER_MS = 15 * 60_000;
const LIMIT = 50;
const MONEY = new Set<ProviderPayment['status']>(['authorized', 'captured', 'refunded']);

/** Applies every payment that moved money on these provider orders; throws ProviderError when Razorpay is unreachable. */
async function applyOrderPayments(d: ReconcileDeps, providerOrderIds: string[]): Promise<ProviderPayment[]> {
  const seen: ProviderPayment[] = [];
  for (const id of providerOrderIds) {
    for (const p of await d.provider.orderPayments(id)) {
      if (!MONEY.has(p.status)) continue;   // created / failed attempts are informational
      await applySnapshot(d.prisma, p, 'SYSTEM');
      seen.push(p);
    }
  }
  return seen;
}

export async function reconcileAttempts(d: ReconcileDeps) {
  const now = (d.now ?? (() => new Date()))();
  const out = { recovered: 0, applied: 0, captured: 0, unlinked: 0, errors: 0 };

  // 1. Attempts whose provider order may or may not exist.
  const stuck = await d.prisma.paymentAttempt.findMany({ where: { status: { in: ['CREATING', 'PROVIDER_UNKNOWN'] }, createdAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) }, order: { status: 'PENDING_PAYMENT' } }, select: { id: true }, take: LIMIT, orderBy: { id: 'asc' } });
  for (const a of stuck) {
    try { if ((await d.checkout.recoverAttempt(a.id)) === 'CREATED') out.recovered++; } catch (e) { out.errors++; d.log.warn({ attempt: a.id, err: String(e) }, 'reconcile: attempt recovery failed'); }
  }

  // 2. Open attempts of pending orders: payments the browser never reported; stale authorizations are captured.
  const open = await d.prisma.paymentAttempt.findMany({ where: { status: 'CREATED', providerOrderId: { not: null }, order: { status: 'PENDING_PAYMENT' } }, select: { id: true, orderId: true, providerOrderId: true }, take: LIMIT, orderBy: { id: 'asc' } });
  for (const a of open) {
    try {
      for (const p of await applyOrderPayments(d, [a.providerOrderId!])) {
        out.applied++;
        if (p.status === 'authorized' && now.getTime() - p.createdAt * 1000 > CAPTURE_AFTER_MS && (await capture(d, p, a.orderId))) out.captured++;
      }
    } catch (e) { out.errors++; if (!(e instanceof ProviderError)) throw e; }
  }

  // 3. UNLINKED payments whose provider order is now mapped to an attempt: re-fetch and apply (recovers once).
  const unlinked = await d.prisma.$queryRaw<{ provider_payment_id: string }[]>`
    SELECT p.provider_payment_id FROM payments p WHERE p.allocation = 'UNLINKED'
       AND EXISTS (SELECT 1 FROM payment_attempts a WHERE a.provider_order_id = p.provider_order_id) ORDER BY p.id LIMIT ${LIMIT}::int`;
  for (const u of unlinked) {
    try { await applySnapshot(d.prisma, await d.provider.fetchPayment(u.provider_payment_id), 'SYSTEM'); out.unlinked++; } catch (e) { out.errors++; if (!(e instanceof ProviderError)) throw e; }
  }
  return out;
}

/** Captures a stale authorization; "already captured" and timeouts are settled by re-fetching (no idempotency key). */
async function capture(d: ReconcileDeps, p: ProviderPayment, orderId: number): Promise<boolean> {
  const order = await d.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (order?.status !== 'PENDING_PAYMENT') return false;
  try { await d.provider.capturePayment(p.id, p.amount); } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    d.log.warn({ payment: p.id, err: e.message }, 'capture failed; re-fetching');
  }
  const after = await d.provider.fetchPayment(p.id);
  await applySnapshot(d.prisma, after, 'SYSTEM');
  if (after.status === 'authorized') {
    await d.prisma.$transaction((tx) => fn.raiseException(tx, { type: 'CAPTURE_STUCK_AUTHORIZED', dedupeKey: `CAPTURE_STUCK_AUTHORIZED:${p.id}`, orderId, amount: p.amount, details: { paymentId: p.id } }));
    return false;
  }
  return true;
}

export async function expirePending(d: Omit<ReconcileDeps, 'provider'> & { provider: PaymentProvider | null }) {
  const now = (d.now ?? (() => new Date()))();
  const out = { expired: 0, placedInstead: 0, skipped: 0 };
  const due = await d.prisma.order.findMany({ where: { status: 'PENDING_PAYMENT', expiresAt: { lte: now } }, include: { paymentAttempts: true }, take: LIMIT * 2, orderBy: { expiresAt: 'asc' } });
  for (const o of due) {
    // Pre-expiry check: every attempt (closed ones too: a retry closes attempts that may still be paid).
    try {
      if (o.paymentAttempts.length) {
        if (!d.provider) throw new ProviderError('UNKNOWN', 'no provider configured');
        const ids = new Set(o.paymentAttempts.flatMap((a) => (a.providerOrderId ? [a.providerOrderId] : [])));
        for (const a of o.paymentAttempts.filter((x) => !x.providerOrderId)) for (const po of await d.provider.findOrdersByReceipt(a.receipt)) ids.add(po.id);
        await applyOrderPayments(d as ReconcileDeps, [...ids]);
      }
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      out.skipped++;
      d.log.warn({ order: o.orderNumber, err: e.message }, 'expiry postponed: Razorpay could not be checked');
      continue;
    }
    const r = await d.prisma.$transaction((tx) => fn.releaseUnpaidOrder(tx, { orderId: o.id, newStatus: 'EXPIRED', reason: 'Not paid in time', actor: 'SYSTEM' }));
    if (r === 'EXPIRED') out.expired++;
    else if ((await d.prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status === 'PLACED') out.placedInstead++;
  }
  return out;
}

export async function reconcileDaily(d: ReconcileDeps, day: Date = new Date(Date.now() - 86_400_000)) {
  const from = Math.floor(new Date(day.toISOString().slice(0, 10) + 'T00:00:00+05:30').getTime() / 1000);
  const to = from + 86_400 - 1;
  const out = { payments: 0, unknownRefunds: 0 };
  for (const p of await d.provider.listPayments(from, to)) {
    if (!p.orderId || !MONEY.has(p.status)) continue;
    await applySnapshot(d.prisma, p, 'SYSTEM');
    out.payments++;
  }
  for (const r of await d.provider.listRefunds(from, to)) {
    const known = await d.prisma.refund.findFirst({ where: { OR: [{ providerRefundId: r.id }, ...(r.notes.aq_refund_id && /^\d+$/.test(r.notes.aq_refund_id) ? [{ id: Number(r.notes.aq_refund_id) }] : [])] }, select: { id: true } });
    if (known) continue;
    const payment = await d.prisma.payment.findUnique({ where: { providerPaymentId: r.paymentId }, select: { id: true, orderId: true } });
    await d.prisma.$transaction((tx) => fn.raiseException(tx, { type: 'RECON_MISMATCH', dedupeKey: `RECON_REFUND:${r.id}`, orderId: payment?.orderId ?? null, paymentId: payment?.id ?? null, amount: r.amount, details: { refundId: r.id, paymentId: r.paymentId, reason: 'refund not in the ArtQ ledger' } }));
    out.unknownRefunds++;
  }
  return out;
}
