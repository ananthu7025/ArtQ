// ✅ AT-16 (task 7.1): a failed refund retried after a newer refund reused its capacity, then retried after the
// capacity frees; UNKNOWN outcomes. Admin API + refund.send consumer + reconciler with a stub Razorpay. Pass: the first
// retry is 409 and the refund stays FAILED; the second creates attempt n+1 with a new X-Refund-Idempotency key and
// receipt; an UNKNOWN outcome resends the same key and the same body (C06 at database level).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileRefunds } from '../../src/payments/refunds.js';
import { createAcceptanceApp, log, type AcceptanceApp } from '../helpers/acceptance-app.js';

let t: AcceptanceApp;
beforeAll(async () => { t = await createAcceptanceApp(); }, 180_000);
afterAll(async () => { await t?.close(); });
beforeEach(() => t.reset());

async function paidOrder() {
  const g = await t.pending();
  const pay = t.fake.pay(g.attempts[0]!);
  expect(await t.captured(pay.id)).toBe('PROCESSED');
  const item = (await t.adminCall('get', `/orders/${g.orderId}/refundable`)).body.items[0];
  return { g, pay, wholeItem: { items: [{ orderItemId: item.orderItemId as number, quantity: item.availableQty as number, amount: item.availableAmount as number }] } };
}
const refundOf = (id: number) => t.prisma.refund.findUniqueOrThrow({ where: { id }, include: { attempts: { orderBy: { attemptNo: 'asc' } } } });

describe('AT-16: retrying a failed refund', () => {
  it('capacity taken by a newer refund → 409, stays FAILED; capacity freed → attempt 2 with a new key and receipt', async () => {
    const { g, wholeItem } = await paidOrder();
    const a = (await t.askRefund(g.orderId, wholeItem)).body.refundId as number;
    t.fake.refundNext = ['definitive'];
    expect(await t.sendRefund(a)).toEqual(['FAILED']);
    expect((await refundOf(a)).status).toBe('FAILED');

    const b = await t.askRefund(g.orderId, wholeItem);   // the released capacity is used by a newer refund
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const blocked = await t.adminCall('post', `/refunds/${a}/retry`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'REFUND_EXCEEDS_CAPACITY', details: { scope: 'item' } });
    expect(await refundOf(a)).toMatchObject({ status: 'FAILED', attempts: [expect.objectContaining({ attemptNo: 1, status: 'FAILED' })] });

    t.fake.refundNext = ['definitive'];
    expect(await t.sendRefund(b.body.refundId)).toEqual(['FAILED']);   // the newer one fails too: capacity is free again
    const retry = await t.adminCall('post', `/refunds/${a}/retry`);
    expect(retry.status, JSON.stringify(retry.body)).toBe(202);
    const after = await refundOf(a);
    expect(after.status).toBe('REQUESTED');
    expect(after.attempts.map((x) => [x.attemptNo, x.status])).toEqual([[1, 'FAILED'], [2, 'SENDING']]);   // attempt 2 is queued for refund.send
    const [first, second] = after.attempts;
    expect(second!.providerIdempotencyKey).toBe(`artq-refund-${a}-a2`);
    expect(second!.providerIdempotencyKey).not.toBe(first!.providerIdempotencyKey);
    expect(second!.receipt).toBe(`AQR_${a}_A2`);
    expect(await t.sendRefund(a)).toEqual(['PROCESSED']);
    expect(t.fake.refundCalls.at(-1)).toMatchObject({ key: `artq-refund-${a}-a2`, body: { receipt: `AQR_${a}_A2`, notes: { aq_attempt: 2 } } });
  });

  it('an UNKNOWN outcome resends the same key and the same body; the provider records one refund', async () => {
    const { g, pay, wholeItem } = await paidOrder();
    const id = (await t.askRefund(g.orderId, wholeItem)).body.refundId as number;
    t.fake.refundNext = ['unknown'];
    expect(await t.sendRefund(id)).toEqual(['UNKNOWN']);
    t.fake.refundNext = ['created-then-unknown'];
    await reconcileRefunds({ prisma: t.prisma, provider: t.provider, log }, { unknownAfterMs: 0 });
    await reconcileRefunds({ prisma: t.prisma, provider: t.provider, log }, { unknownAfterMs: 0 });
    const calls = t.fake.refundCalls.filter((c) => c.paymentId === pay.id);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set([`artq-refund-${id}-a1`]));
    expect(new Set(calls.map((c) => JSON.stringify(c.body))).size).toBe(1);
    expect(t.fake.refunds.filter((r) => r.paymentId === pay.id)).toHaveLength(1);
    const r = await refundOf(id);
    expect(r.attempts).toHaveLength(1);
    expect(r.status).toBe('PROCESSED');
    expect((await t.order(g.orderNumber)).refundedAmount).toBe(wholeItem.items[0]!.amount);
  });
});
