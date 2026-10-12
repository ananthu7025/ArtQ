// ✅ AT-23 (task 7.1): a payment first observed fully refunded / partially refunded; CAPTURED then REFUNDED; an older
// CAPTURED report after REFUNDED; concurrent observations. Stub Razorpay. Pass: fully refunded → VOID, no fulfilment,
// no second refund; partially refunded → HELD + review, only the remainder refundable; later and older observations
// have no side effects; a provider refund ArtQ cannot explain → RECON_MISMATCH (C15 at database level).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySnapshot } from '../../src/payments/apply.js';
import { createAcceptanceApp, type AcceptanceApp } from '../helpers/acceptance-app.js';

let t: AcceptanceApp;
beforeAll(async () => { t = await createAcceptanceApp(); }, 180_000);
afterAll(async () => { await t?.close(); });
beforeEach(() => t.reset());

const paymentOf = (id: string) => t.prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: id } });
const exceptionsOf = (orderId: number, type: string) => t.prisma.paymentException.findMany({ where: { orderId, type: type as never } });
const placedCount = (orderNumber: string) => t.prisma.outboxEvent.count({ where: { eventType: 'order.placed', aggregateId: orderNumber } });

describe('AT-23: refunds ArtQ sees before (or instead of) the capture', () => {
  it('first seen fully refunded, reported concurrently by webhooks, verify and the reconciler → VOID; a late older report changes nothing; nothing fulfilled; no second refund', async () => {
    const g = await t.pending();
    const pay = t.fake.pay(g.attempts[0]!, { status: 'refunded' });
    t.fake.payments.find((p) => p.id === pay.id)!.amountRefunded = pay.amount;
    const ids = await Promise.all([t.hook('payment.captured', { payment: pay.id }), t.hook('payment.refunded', { payment: pay.id })]);
    // Every first report already shows the refund: webhooks, the browser's verify and the reconciler, at once.
    await Promise.all([...ids.map((id) => t.processEvent(id)), g.verify(pay.id), applySnapshot(t.prisma, { ...pay, status: 'refunded', amountRefunded: pay.amount }, 'SYSTEM')]);
    expect(await paymentOf(pay.id)).toMatchObject({ allocation: 'VOID' });
    await applySnapshot(t.prisma, { ...pay, status: 'captured', amountRefunded: 0 }, 'WEBHOOK');   // an older report, delivered late: no effect
    expect(await paymentOf(pay.id)).toMatchObject({ allocation: 'VOID', status: 'REFUNDED' });
    const o = await t.order(g.orderNumber);
    expect(o.status).not.toBe('PLACED');
    expect(o.capturedAmount).toBe(0);
    expect(await placedCount(g.orderNumber)).toBe(0);
    // The provider's own refund is recorded once in the ledger; ArtQ never asks Razorpay for another.
    expect(o.refunds).toEqual([expect.objectContaining({ kind: 'PROVIDER_INITIATED', amount: pay.amount, attempts: [] })]);
    expect(t.fake.refundCalls).toEqual([]);
    expect((await exceptionsOf(o.id, 'REFUNDED_BEFORE_APPLY')).map((e) => e.status)).toEqual(['RESOLVED']);
  });

  it('first seen partially refunded → HELD for review; only the remainder can still be refunded', async () => {
    const g = await t.pending();
    const pay = t.fake.pay(g.attempts[0]!);
    t.fake.payments.find((p) => p.id === pay.id)!.amountRefunded = 20_000;
    await Promise.all([t.captured(pay.id), g.verify(pay.id)]);
    const p = await paymentOf(pay.id);
    expect(p).toMatchObject({ allocation: 'HELD', providerAmountRefunded: 20_000 });
    const o = await t.order(g.orderNumber);
    expect(o.status).not.toBe('PLACED');
    expect(await placedCount(g.orderNumber)).toBe(0);
    expect((await exceptionsOf(o.id, 'REFUNDED_BEFORE_APPLY')).map((e) => e.status)).toEqual(['OPEN']);
    expect(p.amount - Math.max(p.refundReserved, p.providerAmountRefunded)).toBe(pay.amount - 20_000);   // the room left on the payment
  });

  it('CAPTURED and applied, then REFUNDED in the Razorpay dashboard: RECON_MISMATCH once; an older CAPTURED report afterwards changes nothing', async () => {
    const g = await t.pending();
    const pay = t.fake.pay(g.attempts[0]!);
    expect(await t.captured(pay.id)).toBe('PROCESSED');
    const before = await t.order(g.orderNumber);
    expect(before.status).toBe('PLACED');

    const refunded = { ...pay, status: 'refunded' as const, amountRefunded: pay.amount };
    await Promise.all([applySnapshot(t.prisma, refunded, 'WEBHOOK'), applySnapshot(t.prisma, refunded, 'SYSTEM'), applySnapshot(t.prisma, refunded, 'WEBHOOK')]);
    expect(await paymentOf(pay.id)).toMatchObject({ allocation: 'APPLIED', status: 'REFUNDED', providerAmountRefunded: pay.amount });
    expect(await exceptionsOf(before.id, 'RECON_MISMATCH')).toHaveLength(1);

    await applySnapshot(t.prisma, { ...pay, status: 'captured', amountRefunded: 0 }, 'WEBHOOK');   // an older report, delivered late
    expect(await paymentOf(pay.id)).toMatchObject({ status: 'REFUNDED', providerAmountRefunded: pay.amount });
    const after = await t.order(g.orderNumber);
    expect([after.status, after.capturedAmount, after.refunds.length]).toEqual([before.status, before.capturedAmount, 0]);
    expect(await placedCount(g.orderNumber)).toBe(1);
    expect(await exceptionsOf(before.id, 'RECON_MISMATCH')).toHaveLength(1);
    expect(t.fake.refundCalls).toEqual([]);
  });
});
