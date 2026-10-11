// ✅ AT-22 (task 7.1): the webhook for a capture arrives before TX2 saved the provider order id; then the reconciler
// saves it; webhook redelivery, the browser's verify and the reconciler race. Stub Razorpay. Pass: the first report is
// UNLINKED with no order effects; after the mapping exactly one APPLIED, effects once, the exception resolved;
// conflicting order / amount reports never attach; unmatched payments stay visible (C14 at database level).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySnapshot } from '../../src/payments/apply.js';
import { reconcileAttempts } from '../../src/payments/reconcile.js';
import { createAcceptanceApp, type AcceptanceApp } from '../helpers/acceptance-app.js';

let t: AcceptanceApp;
beforeAll(async () => { t = await createAcceptanceApp(); }, 180_000);
afterAll(async () => { await t?.close(); });
beforeEach(() => t.reset());

const effects = async (orderNumber: string, orderId: number) => ({
  placed: await t.prisma.outboxEvent.count({ where: { eventType: 'order.placed', aggregateId: orderNumber } }),
  history: await t.prisma.orderStatusHistory.count({ where: { orderId, toValue: 'PLACED' } }),
  sold: (await t.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: { include: { variant: { include: { product: true } } } } } })).items[0]!.variant!.product.soldCount,
});
const openUnlinked = (paymentId: string) => t.prisma.paymentException.count({ where: { type: 'UNLINKED_PAYMENT', status: 'OPEN', payment: { providerPaymentId: paymentId } } });

describe('AT-22: a capture reported before its provider order was mapped', () => {
  it('UNLINKED first with no order effects; after the mapping, verify + webhook redelivery + reconciler race → one APPLIED, effects once', async () => {
    const c = await t.crashedInitiate();
    const pay = t.fake.pay(c.providerOrderId);
    expect(await t.captured(pay.id)).toBe('PROCESSED');
    expect(await t.prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: pay.id } })).toMatchObject({ allocation: 'UNLINKED', orderId: null });
    expect((await t.order(c.orderNumber)).status).toBe('PENDING_PAYMENT');
    expect(await effects(c.orderNumber, c.orderId)).toEqual({ placed: 0, history: 0, sold: 0 });
    expect(await openUnlinked(pay.id)).toBe(1);

    await t.prisma.paymentAttempt.update({ where: { id: c.attempt.id }, data: { createdAt: new Date(Date.now() - 61_000) } });   // old enough to recover
    const redelivered = await t.hook('payment.captured', { payment: pay.id });
    await Promise.all([reconcileAttempts(t.deps()), t.processEvent(redelivered), c.verify(pay.id), reconcileAttempts(t.deps()), c.verify(pay.id)]);
    await reconcileAttempts(t.deps());   // whichever ran first did the mapping; everything after it is a no-op

    const o = await t.order(c.orderNumber);
    expect(o.payments).toEqual([expect.objectContaining({ providerPaymentId: pay.id, allocation: 'APPLIED' })]);
    expect([o.status, o.paymentStatus, o.capturedAmount]).toEqual(['PLACED', 'PAID', c.total]);
    expect(await effects(c.orderNumber, c.orderId)).toEqual({ placed: 1, history: 1, sold: 1 });
    expect(await openUnlinked(pay.id)).toBe(0);
  });

  it('a conflicting report (other provider order, other amount) never attaches or changes the payment', async () => {
    const c = await t.crashedInitiate();
    const pay = t.fake.pay(c.providerOrderId);
    await t.captured(pay.id);
    const other = await t.pending();                          // another customer's order
    for (const lie of [{ ...pay, orderId: other.attempts[0]! }, { ...pay, amount: pay.amount + 100 }]) {
      expect(await applySnapshot(t.prisma, lie, 'WEBHOOK')).toBe('CONFLICT');
    }
    expect(await t.prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: pay.id } })).toMatchObject({ allocation: 'UNLINKED', orderId: null, amount: pay.amount });
    expect(await t.prisma.paymentException.count({ where: { type: 'PAYMENT_IDENTITY_CONFLICT', payment: { providerPaymentId: pay.id } } })).toBeGreaterThanOrEqual(1);
    expect((await t.order(other.orderNumber)).payments).toEqual([]);

    await t.prisma.paymentAttempt.update({ where: { id: c.attempt.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
    await reconcileAttempts(t.deps());
    expect(await t.prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: pay.id } })).toMatchObject({ allocation: 'APPLIED', orderId: c.orderId, amount: pay.amount });
    expect(await applySnapshot(t.prisma, { ...pay, amount: pay.amount + 100 }, 'CUSTOMER')).toBe('CONFLICT');   // still refused after the mapping
    expect((await t.order(c.orderNumber)).capturedAmount).toBe(c.total);
  });

  it('a payment on a Razorpay order ArtQ never made (e.g. a dashboard payment link) stays UNLINKED and visible to staff', async () => {
    const outside = await t.fake.createOrder({ amount: 50_000, receipt: 'dashboard-link', notes: {} });
    const stray = t.fake.pay(outside.id);
    expect(await t.captured(stray.id)).toBe('PROCESSED');
    await reconcileAttempts(t.deps());
    await reconcileAttempts(t.deps());
    expect(await t.prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: stray.id } })).toMatchObject({ allocation: 'UNLINKED', orderId: null });
    expect(await openUnlinked(stray.id)).toBe(1);
  });
});
