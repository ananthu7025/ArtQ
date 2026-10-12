// ✅ AT-24 (task 7.1): an AUTHORIZED payment the provider voids / refunds before expiry; a HELD or APPLIED payment
// refunded further in the Razorpay dashboard, then staff ask for a refund or retry a failed one. Stub Razorpay + admin
// API. Pass: the order returns PROCESSING → UNPAID and expires once (stock and coupon released once); while provider
// refunds are unexplained, new refunds and retries get 409 REFUND_RECONCILIATION_REQUIRED; reconciliation records the
// outside refunds once without double-counting ArtQ's own, then the capacity reflects them (C16 at database level).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySnapshot } from '../../src/payments/apply.js';
import { expirePending, reconcileAttempts } from '../../src/payments/reconcile.js';
import { reconcileRefunds } from '../../src/payments/refunds.js';
import { createAcceptanceApp, log, type AcceptanceApp } from '../helpers/acceptance-app.js';
import { uniq } from '../helpers/fixtures.js';

let t: AcceptanceApp;
beforeAll(async () => { t = await createAcceptanceApp(); }, 180_000);
afterAll(async () => { await t?.close(); });
beforeEach(() => t.reset());
const refundDeps = () => ({ prisma: t.prisma, provider: t.provider, log });

describe('AT-24: an authorization voided at the provider', () => {
  it('PROCESSING → UNPAID; expires once; stock and the coupon released once', async () => {
    const coupon = await t.prisma.coupon.create({ data: { code: `AT24${uniq().toUpperCase()}`, title: 'x', type: 'FLAT', value: 5000, usageLimitPerCustomer: null } });
    const g = await t.pending({ onHand: 4, couponCode: coupon.code });
    const variant = () => t.prisma.productVariant.findUniqueOrThrow({ where: { id: g.p.variantIds[0]! } });
    const couponNow = () => t.prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect((await variant()).reserved).toBe(1);
    expect((await couponNow()).reservedCount).toBe(1);

    const auth = t.fake.pay(g.attempts[0]!, { status: 'authorized' });
    await reconcileAttempts(t.deps());
    expect((await t.order(g.orderNumber)).paymentStatus).toBe('PROCESSING');
    Object.assign(t.fake.payments.find((p) => p.id === auth.id)!, { status: 'refunded', amountRefunded: auth.amount });   // the provider voids it
    await Promise.all([reconcileAttempts(t.deps()), t.captured(auth.id), reconcileAttempts(t.deps())]);
    expect(await t.order(g.orderNumber)).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID' });

    await t.prisma.order.update({ where: { orderNumber: g.orderNumber }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const runs = await Promise.all([expirePending(t.deps()), expirePending(t.deps())]);
    expect(runs.reduce((n, r) => n + r.expired, 0)).toBe(1);
    expect(await expirePending(t.deps())).toMatchObject({ expired: 0 });
    expect((await t.order(g.orderNumber)).status).toBe('EXPIRED');
    expect(await variant()).toMatchObject({ reserved: 0, onHand: 4 });
    expect(await couponNow()).toMatchObject({ reservedCount: 0, redeemedCount: 0 });
    expect(await t.prisma.orderStatusHistory.count({ where: { orderId: g.orderId, toValue: 'EXPIRED' } })).toBe(1);
  });
});

describe('AT-24: refunds made in the Razorpay dashboard', () => {
  it('new refunds and retries 409 while unexplained; reconciled once without double-counting ArtQ’s own; then capacity follows', async () => {
    const g = await t.pending();
    const pay = t.fake.pay(g.attempts[0]!);
    await t.captured(pay.id);
    const item = (await t.adminCall('get', `/orders/${g.orderId}/refundable`)).body.items[0];
    const part = (amount: number) => ({ items: [{ orderItemId: item.orderItemId as number, quantity: 0, amount }] });

    const ours = (await t.askRefund(g.orderId, part(10_000))).body.refundId as number;   // ArtQ's own refund, processed
    expect(await t.sendRefund(ours)).toEqual(['PROCESSED']);
    const failed = (await t.askRefund(g.orderId, part(5000))).body.refundId as number;   // and one that failed
    t.fake.refundNext = ['definitive'];
    expect(await t.sendRefund(failed)).toEqual(['FAILED']);

    await t.fake.createRefund(pay.id, { amount: 20_000, speed: 'normal', receipt: 'dashboard-at24', notes: {} }, 'dashboard-at24');   // someone refunds ₹200 in the dashboard
    await applySnapshot(t.prisma, { ...t.fake.payments.find((p) => p.id === pay.id)!, amountRefunded: 30_000 }, 'WEBHOOK');           // Razorpay now reports ₹300 refunded in total

    const blocked = await t.askRefund(g.orderId, part(1000));
    expect([blocked.status, blocked.body.error?.code]).toEqual([409, 'REFUND_RECONCILIATION_REQUIRED']);
    const retry = await t.adminCall('post', `/refunds/${failed}/retry`);
    expect([retry.status, retry.body.error?.code]).toEqual([409, 'REFUND_RECONCILIATION_REQUIRED']);
    expect((await t.adminCall('get', `/orders/${g.orderId}/refundable`)).body.payment.reconciliationRequired).toBe(true);

    await Promise.all([reconcileRefunds(refundDeps()), reconcileRefunds(refundDeps())]);
    await reconcileRefunds(refundDeps());
    const outside = await t.prisma.refund.findMany({ where: { orderId: g.orderId, kind: 'PROVIDER_INITIATED' } });
    expect(outside).toEqual([expect.objectContaining({ amount: 20_000, status: 'PROCESSED' })]);   // once, and only the part ArtQ did not make
    const view = (await t.adminCall('get', `/orders/${g.orderId}/refundable`)).body;
    expect(view.payment).toMatchObject({ reconciliationRequired: false, available: pay.amount - 10_000 - 20_000 });

    expect((await t.askRefund(g.orderId, part(1000))).status).toBe(201);
    expect((await t.adminCall('post', `/refunds/${failed}/retry`)).status).toBe(202);
  });
});
