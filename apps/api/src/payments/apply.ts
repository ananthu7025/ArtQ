// The one way a provider payment changes ArtQ (architecture.md §7.1, database.md §8.2): fetch the payment from Razorpay
// (never trust the browser), then aq_apply_provider_payment in one short transaction. Used by checkout verify (4.8),
// payment retry (4.8), the webhook worker and the reconcilers (4.9).
import type { PrismaClient } from '@prisma/client';
import * as fn from '../db/functions.js';
import type { PaymentProvider, ProviderPayment } from './razorpay.js';

const STATUS: Record<ProviderPayment['status'], fn.ProviderPaymentStatus> = { created: 'CREATED', failed: 'FAILED', authorized: 'AUTHORIZED', captured: 'CAPTURED', refunded: 'REFUNDED' };

/** Applies an already-fetched snapshot. A payment with no provider order cannot belong to a checkout: null. */
export async function applySnapshot(prisma: PrismaClient, p: ProviderPayment, actor: fn.ActorType): Promise<string | null> {
  if (!p.orderId) return null;
  return prisma.$transaction((tx) => fn.applyProviderPayment(tx, {
    providerOrderId: p.orderId!, paymentId: p.id, amount: p.amount, currency: p.currency, status: STATUS[p.status],
    amountRefunded: p.amountRefunded, capturedAt: p.status === 'captured' || p.status === 'refunded' ? new Date(p.createdAt * 1000) : null,
    method: p.method, raw: p.raw, actor,
  }), { timeout: 30_000 });
}

/** Fetch (outside any transaction) then apply. Throws ProviderError when Razorpay cannot be reached. */
export async function fetchAndApply(prisma: PrismaClient, provider: PaymentProvider, paymentId: string, actor: fn.ActorType): Promise<{ outcome: string | null; payment: ProviderPayment }> {
  const payment = await provider.fetchPayment(paymentId);
  return { outcome: await applySnapshot(prisma, payment, actor), payment };
}
