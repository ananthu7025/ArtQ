// ✅ AT-15 (task 7.1): an excess capture after the order was PARTIALLY_REFUNDED and after it was REFUNDED. Through the
// real checkout, admin refund API and signed webhooks with a stub Razorpay. Pass: allocation EXCESS, an automatic
// refund of the excess, the order's totals unchanged, `order.placed` not emitted again (C04 at database level).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAcceptanceApp, type AcceptanceApp } from '../helpers/acceptance-app.js';

let t: AcceptanceApp;
beforeAll(async () => { t = await createAcceptanceApp(); }, 180_000);
afterAll(async () => { await t?.close(); });
beforeEach(() => t.reset());

/** Paid on its second payment window, then refunded through the admin API (part, or everything). */
async function refundedOrder(how: 'part' | 'all') {
  const g = await t.pending({ attempts: 2 });
  const [first, second] = g.attempts;
  const applied = t.fake.pay(second!);
  expect(await t.captured(applied.id)).toBe('PROCESSED');
  const refundable = (await t.adminCall('get', `/orders/${g.orderId}/refundable`)).body;
  const item = refundable.items[0];
  const body = how === 'part'
    ? { items: [{ orderItemId: item.orderItemId, quantity: 0, amount: 10_000 }] }
    : { items: [{ orderItemId: item.orderItemId, quantity: item.availableQty, amount: item.availableAmount }], shippingAmount: refundable.shipping.available, codFeeAmount: refundable.codFee?.available ?? 0 };
  const r = await t.askRefund(g.orderId, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(await t.sendRefund(r.body.refundId)).toEqual(['PROCESSED']);
  return { g, firstWindow: first!, applied, refundId: r.body.refundId as number };
}
const totalsOf = async (orderNumber: string) => {
  const o = await t.order(orderNumber);
  return { total: o.total, subtotal: o.subtotal, shippingFee: o.shippingFee, capturedAmount: o.capturedAmount, refundedAmount: o.refundedAmount, status: o.status, paymentStatus: o.paymentStatus };
};
const placedEvents = (orderNumber: string) => t.prisma.outboxEvent.count({ where: { eventType: 'order.placed', aggregateId: orderNumber } });

describe('AT-15: excess capture after a refund', () => {
  for (const how of ['part', 'all'] as const) {
    const label = how === 'part' ? 'PARTIALLY_REFUNDED' : 'REFUNDED';
    it(`after ${label}: the late capture is EXCESS and refunded automatically; totals and order.placed unchanged`, async () => {
      const { g, firstWindow } = await refundedOrder(how);
      const before = await totalsOf(g.orderNumber);
      expect(before.paymentStatus).toBe(label);
      expect(await placedEvents(g.orderNumber)).toBe(1);

      const late = t.fake.pay(firstWindow);               // the customer had also paid in the first window
      expect(await t.captured(late.id)).toBe('PROCESSED');
      expect(await t.captured(late.id)).toBe('PROCESSED');   // Razorpay redelivers: nothing more happens

      const o = await t.order(g.orderNumber);
      expect(o.payments.find((p) => p.providerPaymentId === late.id)).toMatchObject({ allocation: 'EXCESS', status: 'CAPTURED' });
      expect(o.payments.filter((p) => p.allocation === 'APPLIED')).toHaveLength(1);
      const excess = o.refunds.filter((r) => r.kind === 'EXCESS_CAPTURE');
      expect(excess).toEqual([expect.objectContaining({ status: 'REQUESTED', amount: late.amount })]);
      expect(o.exceptions.filter((e) => e.type === 'EXCESS_CAPTURE')).toHaveLength(1);
      expect(await totalsOf(g.orderNumber)).toEqual(before);   // the excess never touches the order's totals or status
      expect(await placedEvents(g.orderNumber)).toBe(1);

      // The automatic refund goes back to the late payment, for exactly its amount, and closes the exception.
      expect(await t.sendRefund(excess[0]!.id)).toEqual(['PROCESSED']);
      expect(t.fake.refundCalls.at(-1)).toMatchObject({ paymentId: late.id, body: { amount: late.amount } });
      const after = await t.order(g.orderNumber);
      expect(after.exceptions.find((e) => e.type === 'EXCESS_CAPTURE')).toMatchObject({ status: 'RESOLVED' });
      expect(await totalsOf(g.orderNumber)).toEqual(before);
    });
  }
});
