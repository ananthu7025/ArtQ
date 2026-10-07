// Refund sending and reconciliation (task 5.4; architecture.md §10.2 and §7.4, database.md §4.5). The database
// functions own every state change; this file only talks to Razorpay (never inside a transaction) and records what
// it heard through aq_refund_attempt_result / aq_mark_refund_processed / aq_reconcile_provider_refunds.
//
//   refund.send (outbox consumer) — POST /payments/{id}/refund with the attempt's X-Refund-Idempotency key and its
//     stored, immutable body. Outcome mapping (§10.2): 2xx → ACCEPTED_PENDING / ACCEPTED_PROCESSED; timeout, 5xx →
//     UNKNOWN; 409 "still in progress" → IN_PROGRESS; "different request with the same idempotency key" → MISMATCH
//     (exception, never retried automatically); other 4xx → FAILED, but only after the payment's refunds were listed
//     and none of them is this attempt (an earlier send may have succeeded).
//   refunds.reconcile (every 5 min) — payments whose provider-refunded total exceeds the ledger (gate closed) →
//     aq_reconcile_provider_refunds; UNKNOWN attempts → matched by receipt / notes.aq_refund_id, else the SAME
//     attempt is sent again; PENDING refunds → fetched and marked processed (or failed).
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import * as fn from '../db/functions.js';
import { loadDelivery } from '../outbox/consume.js';
import { ProviderError, type PaymentProvider, type ProviderRefund, type RefundRequestBody } from './razorpay.js';

export type RefundDeps = { prisma: PrismaClient; provider: PaymentProvider; log: Logger };
type Outcome = { outcome: fn.RefundAttemptOutcome; http: number | null; response: unknown; providerRefundId: string | null };

/** Razorpay's minimum refund (task 4.0): below ₹1 is refused before calling. */
export const MIN_REFUND = 100;

const accepted = (r: ProviderRefund, http: number | null): Outcome => r.status === 'failed'
  ? { outcome: 'FAILED', http, response: { description: 'Razorpay reports the refund as failed', refund: r.id }, providerRefundId: r.id }
  : { outcome: r.status === 'processed' ? 'ACCEPTED_PROCESSED' : 'ACCEPTED_PENDING', http, response: { id: r.id, status: r.status }, providerRefundId: r.id };

/** This attempt's refund among the payment's refunds (receipt first, then our refund id in the notes). */
export function matchAttempt(list: ProviderRefund[], a: { receipt: string; refundId: number; attemptNo: number }): ProviderRefund | null {
  return list.find((r) => r.receipt === a.receipt)
    ?? list.find((r) => String(r.notes.aq_refund_id) === String(a.refundId) && String(r.notes.aq_attempt ?? a.attemptNo) === String(a.attemptNo))
    ?? null;
}

/** Sends (or re-sends) one attempt exactly as stored and records the outcome. Returns what was recorded. */
export async function sendRefundAttempt(d: RefundDeps, attemptId: number): Promise<string> {
  const a = await d.prisma.refundAttempt.findUnique({ where: { id: attemptId }, include: { refund: { include: { payment: { select: { providerPaymentId: true } } } } } });
  if (!a) throw new TypeError(`refund attempt ${attemptId} not found`);
  const rf = a.refund;
  if (rf.attemptNo !== a.attemptNo || !['REQUESTED', 'UNKNOWN'].includes(rf.status) || a.status === 'MISMATCH') return 'STALE';
  if (!rf.payment) throw new TypeError(`refund ${rf.id} has no payment to refund`);
  const record = (o: Outcome) => d.prisma.$transaction((tx) => fn.refundAttemptResult(tx, { attemptId, outcome: o.outcome, httpStatus: o.http, response: o.response, providerRefundId: o.providerRefundId }));
  if (rf.amount < MIN_REFUND) return record({ outcome: 'FAILED', http: null, response: { description: 'Refunds under ₹1 are not possible with Razorpay' }, providerRefundId: null });

  let o: Outcome;
  try {
    o = accepted(await d.provider.createRefund(rf.payment.providerPaymentId, a.request as RefundRequestBody, a.providerIdempotencyKey), 200);
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    const response = { description: e.message.replace(/^Razorpay \d+: /, ''), kind: e.kind };
    if (e.kind === 'UNKNOWN') o = { outcome: 'UNKNOWN', http: e.httpStatus, response, providerRefundId: null };
    else if (/still in progress/i.test(e.message)) o = { outcome: 'IN_PROGRESS', http: e.httpStatus, response, providerRefundId: null };
    else if (/different request|same idempotency key/i.test(e.message)) o = { outcome: 'MISMATCH', http: e.httpStatus, response, providerRefundId: null };
    else {
      // A definitive refusal: make sure an earlier send of this attempt did not succeed before calling it failed.
      try {
        const found = matchAttempt(await d.provider.paymentRefunds(rf.payment.providerPaymentId), { receipt: a.receipt, refundId: rf.id, attemptNo: a.attemptNo });
        o = found ? accepted(found, e.httpStatus) : { outcome: 'FAILED', http: e.httpStatus, response, providerRefundId: null };
      } catch (listError) {
        if (!(listError instanceof ProviderError)) throw listError;
        o = { outcome: 'UNKNOWN', http: e.httpStatus, response: { ...response, check: 'refund list unavailable' }, providerRefundId: null };
      }
    }
  }
  const r = await record(o);
  d.log.info({ refundId: rf.id, attempt: a.attemptNo, outcome: o.outcome, recorded: r }, 'refund attempt recorded');
  return r;
}

/** Outbox consumer `refund.send`. */
export async function processRefundSend(d: RefundDeps, deliveryId: number): Promise<string> {
  const ev = await d.prisma.$transaction(async (tx) => ((await fn.outboxBeginConsume(tx, deliveryId)) ? loadDelivery(tx, deliveryId) : null));
  if (!ev) return 'ALREADY_DONE';
  const attemptId = Number((ev.payload as { refund_attempt_id?: unknown } | null)?.refund_attempt_id);
  if (!Number.isSafeInteger(attemptId) || attemptId <= 0) throw new TypeError(`refund.requested event ${ev.eventId} has no refund_attempt_id`);
  const r = await sendRefundAttempt(d, attemptId);
  // UNKNOWN is handed to the reconciler (it re-checks and resends the same attempt), so the delivery is done either way.
  await d.prisma.$transaction(async (tx) => { if (await fn.outboxBeginConsume(tx, deliveryId)) await fn.outboxComplete(tx, deliveryId); });
  return r;
}

const toLedger = (r: ProviderRefund): fn.ProviderRefund => ({ id: r.id, amount: r.amount, status: r.status, receipt: r.receipt, notes: r.notes.aq_refund_id === undefined ? {} : { aq_refund_id: r.notes.aq_refund_id } });

export type RefundReconcileResult = { gates: number; resent: number; matched: number; processed: number; failed: number; errors: number };

/** The refunds.reconcile job (every 5 minutes). `unknownAfterMs`: leave very recent UNKNOWN attempts to the first send. */
export async function reconcileRefunds(d: RefundDeps, o: { unknownAfterMs?: number; limit?: number } = {}): Promise<RefundReconcileResult> {
  const limit = o.limit ?? 50;
  const out: RefundReconcileResult = { gates: 0, resent: 0, matched: 0, processed: 0, failed: 0, errors: 0 };
  const safely = async (what: string, work: () => Promise<void>) => {
    try { await work(); } catch (e) { out.errors++; d.log.warn({ err: (e as Error).message, what }, 'refund reconciliation step failed'); }
  };

  // 1. Closed gates: the provider reports more refunded than the ledger explains.
  const gated = await d.prisma.$queryRaw<{ id: number; ppid: string }[]>`
    SELECT id, provider_payment_id AS ppid FROM payments WHERE provider_amount_refunded > refund_reserved AND order_id IS NOT NULL ORDER BY id LIMIT ${limit}`;
  for (const p of gated) await safely(`gate ${p.id}`, async () => {
    const list = await d.provider.paymentRefunds(p.ppid);
    await d.prisma.$transaction((tx) => fn.reconcileProviderRefunds(tx, p.id, list.map(toLedger)));
    out.gates++;
  });

  // 2. UNKNOWN attempts: found at Razorpay → recorded; not found → the same attempt is sent again.
  const before = new Date(Date.now() - (o.unknownAfterMs ?? 120_000));
  const unknown = await d.prisma.refundAttempt.findMany({
    where: { status: 'UNKNOWN', updatedAt: { lt: before }, refund: { status: 'UNKNOWN' } },
    include: { refund: { include: { payment: { select: { providerPaymentId: true } } } } }, orderBy: { id: 'asc' }, take: limit,
  });
  for (const a of unknown) await safely(`unknown attempt ${a.id}`, async () => {
    if (a.refund.attemptNo !== a.attemptNo || !a.refund.payment) return;
    const found = matchAttempt(await d.provider.paymentRefunds(a.refund.payment.providerPaymentId), { receipt: a.receipt, refundId: a.refundId, attemptNo: a.attemptNo });
    if (found) {
      const o2 = accepted(found, null);
      await d.prisma.$transaction((tx) => fn.refundAttemptResult(tx, { attemptId: a.id, outcome: o2.outcome, httpStatus: null, response: { reconciled: true, ...(o2.response as object) }, providerRefundId: found.id }));
      out.matched++;
    } else {
      await sendRefundAttempt(d, a.id);
      out.resent++;
    }
  });

  // 3. PENDING refunds: processed (or failed) at Razorpay since.
  const pending = await d.prisma.refund.findMany({ where: { status: 'PENDING', providerRefundId: { not: null } }, orderBy: { id: 'asc' }, take: limit,
    select: { id: true, providerRefundId: true, attemptNo: true, attempts: { select: { id: true, attemptNo: true } } } });
  for (const r of pending) await safely(`pending refund ${r.id}`, async () => {
    const p = await d.provider.fetchRefund(r.providerRefundId!);
    if (p.status === 'processed') { if ((await d.prisma.$transaction((tx) => fn.markRefundProcessed(tx, r.id, p.id))) === 'PROCESSED') out.processed++; }
    else if (p.status === 'failed') {
      const current = r.attempts.find((x) => x.attemptNo === r.attemptNo);
      if (current) { await d.prisma.$transaction((tx) => fn.refundAttemptResult(tx, { attemptId: current.id, outcome: 'FAILED', httpStatus: null, response: { description: 'Razorpay reports the refund as failed', refund: p.id }, providerRefundId: p.id })); out.failed++; }
    }
  });
  return out;
}
