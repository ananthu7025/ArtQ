// Razorpay webhook handlers (task 4.9; architecture.md §8.1, api.md §5). The webhook body only names the object: every
// handler re-fetches the payment or refund from Razorpay (outside any transaction) and applies that snapshot inside the
// fenced webhook transaction, so event order, duplicates and forged-but-signed payloads change nothing.
import type { Prisma } from '@prisma/client';
import * as fn from '../db/functions.js';
import type { WebhookHandler } from '../webhooks/provider.js';
import { applyInTx } from './apply.js';
import { ProviderError, type PaymentProvider, type ProviderPayment, type ProviderRefund } from './razorpay.js';

type Payload = { payload?: { payment?: { entity?: { id?: string } }; refund?: { entity?: { id?: string } } } };
const paymentIdOf = (b: unknown) => (b as Payload)?.payload?.payment?.entity?.id ?? null;
const refundIdOf = (b: unknown) => (b as Payload)?.payload?.refund?.entity?.id ?? null;

/** payment.authorized / captured / failed and order.paid: re-fetch the payment, then aq_apply_provider_payment. */
function paymentHandler(provider: PaymentProvider): WebhookHandler<ProviderPayment | null> {
  return {
    async fetch(ev) {
      const id = paymentIdOf(ev.payload);
      if (!id) return null;
      try { return await provider.fetchPayment(id); } catch (e) {
        if (e instanceof ProviderError && e.kind === 'DEFINITIVE') return null;   // not a payment of this account: nothing to do
        throw e;                                                                    // unreachable: the inbox retries with backoff
      }
    },
    async apply(tx, p) {
      if (!p) return 'IGNORED';
      return (await applyInTx(tx as fn.Db, p, 'WEBHOOK')) === null ? 'IGNORED' : 'PROCESSED';
    },
  };
}

/**
 * refund.created / processed / failed: our own refund (matched by its provider id, or `notes.aq_refund_id`) is marked
 * processed, or its attempt failed (capacity released, task 5.4), when Razorpay says so. Refunds ArtQ did not make are left to the refund reconciliation (task 5.4), which
 * records them once and raises RECON_MISMATCH.
 */
function refundHandler(provider: PaymentProvider): WebhookHandler<ProviderRefund | null> {
  return {
    async fetch(ev) {
      const id = refundIdOf(ev.payload);
      if (!id) return null;
      try { return await provider.fetchRefund(id); } catch (e) {
        if (e instanceof ProviderError && e.kind === 'DEFINITIVE') return null;
        throw e;
      }
    },
    async apply(tx, r) {
      if (!r || r.status === 'pending') return 'IGNORED';
      const ours = await (tx as Prisma.TransactionClient).refund.findFirst({
        where: { OR: [{ providerRefundId: r.id }, ...(r.notes.aq_refund_id && /^\d+$/.test(r.notes.aq_refund_id) ? [{ id: Number(r.notes.aq_refund_id) }] : [])] },
        select: { id: true, attemptNo: true, attempts: { select: { id: true, attemptNo: true, receipt: true } } },
      });
      if (!ours) return 'IGNORED';
      if (r.status === 'processed') { await fn.markRefundProcessed(tx as fn.Db, ours.id, r.id); return 'PROCESSED'; }
      // refund.failed: only the attempt Razorpay refused (by receipt, else the current one) is recorded FAILED; a stale one is ignored.
      const attempt = ours.attempts.find((a) => a.receipt === r.receipt) ?? ours.attempts.find((a) => a.attemptNo === ours.attemptNo);
      if (!attempt) return 'IGNORED';
      const out = await fn.refundAttemptResult(tx as fn.Db, { attemptId: attempt.id, outcome: 'FAILED', httpStatus: null, response: { description: 'Razorpay reports the refund as failed', refund: r.id }, providerRefundId: r.id });
      return out === 'STALE' ? 'IGNORED' : 'PROCESSED';
    },
  };
}

export function razorpayHandlers(provider: PaymentProvider): Record<string, WebhookHandler> {
  const payment = paymentHandler(provider) as WebhookHandler;
  const refund = refundHandler(provider) as WebhookHandler;
  return {
    'payment.authorized': payment, 'payment.captured': payment, 'payment.failed': payment, 'order.paid': payment,
    'refund.created': refund, 'refund.processed': refund, 'refund.failed': refund,
  };
}
