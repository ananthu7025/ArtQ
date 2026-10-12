// ✅ AT-20 (task 7.1): the same Idempotency-Key and identical body reused against a different order (cancel, payment
// retry, refund, return), and request takeover: request A stalls past its lease, B takes over, A resumes. Real routes.
// Pass: cross-resource reuse → 422 IDEMPOTENCY_KEY_REUSED; takeover → one order (resumed), A's later work rolls back and
// A gets 409 REQUEST_SUPERSEDED, later retries replay B; concurrent takeovers → one owner (C10 at database level).
// At checkout, B resumes the order while A's Razorpay call is still in flight, so B answers 202 PAYMENT_STARTING rather
// than create a second provider order; the reconciler adopts A's provider order by receipt and retries settle on it.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileAttempts } from '../../src/payments/reconcile.js';
import { ADMIN_ORIGIN, createAcceptanceApp, WEB, type AcceptanceApp } from '../helpers/acceptance-app.js';

let t: AcceptanceApp;
beforeAll(async () => { t = await createAcceptanceApp(); }, 180_000);
afterAll(async () => { await t?.close(); });
beforeEach(() => t.reset());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reused = (res: request.Response) => [res.status, res.body.error?.code];

describe('AT-20: one key, one resource', () => {
  it('staff: the same key and body on another order’s cancel or refund → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const [a, b] = [await t.pending(), await t.pending()];
    for (const o of [a, b]) await t.captured(t.fake.pay(o.attempts[0]!).id);
    const cancel = (orderId: number, key: string) => request(t.app).post(`/v1/admin/orders/${orderId}/cancel`).set('Origin', ADMIN_ORIGIN).set('Authorization', `Bearer ${t.ownerToken}`).set('Idempotency-Key', key).send({ reason: 'Customer asked by phone' });
    const key = randomUUID();
    expect((await cancel(a.orderId, key)).status).toBe(200);
    expect(reused(await cancel(b.orderId, key))).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    expect((await t.order(b.orderNumber)).status).toBe('PLACED');   // nothing happened to B

    const [c, d] = [await t.pending(), await t.pending()];
    for (const o of [c, d]) await t.captured(t.fake.pay(o.attempts[0]!).id);
    const body = { kind: 'GOODWILL', reason: 'Same note', shippingAmount: 0, items: [] as object[] };
    const rkey = randomUUID();
    const first = await t.askRefund(c.orderId, { ...body, items: [{ orderItemId: await t.itemOf(c.orderId), quantity: 0, amount: 1000 }] }, rkey);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(reused(await t.askRefund(d.orderId, { ...body, items: [{ orderItemId: await t.itemOf(c.orderId), quantity: 0, amount: 1000 }] }, rkey))).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    expect(await t.prisma.refund.count({ where: { orderId: d.orderId } })).toBe(0);
  });

  it('a signed-in customer: the same key on another order’s payment retry, cancel or return → 422', async () => {
    const me = await t.customer();
    const as = (path: string, key: string, body: object) => request(t.app).post(`/v1${path}`).set('Origin', WEB).set('Authorization', `Bearer ${me.token}`).set('Idempotency-Key', key).send(body);
    const a = await t.pending({ customer: me });
    const retryKey = randomUUID();
    const retried = await as(`/orders/${a.orderNumber}/payment/retry`, retryKey, { paymentMethod: 'RAZORPAY' });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    await t.captured(t.fake.pay(retried.body.razorpay.orderId).id);   // A is paid, so the customer's next cart makes a new order
    const b = await t.pending({ customer: me });
    expect(b.orderNumber).not.toBe(a.orderNumber);
    expect(reused(await as(`/orders/${b.orderNumber}/payment/retry`, retryKey, { paymentMethod: 'RAZORPAY' }))).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);

    const returnKey = randomUUID();
    const ret = { reason: 'MISSING_ITEM', items: [{ orderItemId: await t.itemOf(a.orderId), quantity: 1 }] };
    expect((await as(`/me/orders/${a.orderNumber}/returns`, returnKey, ret)).status).toBe(422);   // not delivered: refused, and that answer is stored
    expect(reused(await as(`/me/orders/${b.orderNumber}/returns`, returnKey, ret))).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);

    const cancelKey = randomUUID();
    const cancelled = await as(`/me/orders/${a.orderNumber}/cancel`, cancelKey, { reason: 'Changed my mind' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(reused(await as(`/me/orders/${b.orderNumber}/cancel`, cancelKey, { reason: 'Changed my mind' }))).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    expect((await t.order(b.orderNumber)).status).toBe('PENDING_PAYMENT');   // nothing happened to B
  });
});

describe('AT-20: takeover of a stalled request', () => {
  /** Razorpay's create-order call hangs for the first request only. */
  function stallFirstCreate() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const real = t.fake.createOrder.bind(t.fake);
    let calls = 0;
    t.fake.createOrder = async (o) => { calls++; if (calls === 1) await gate; return real(o); };
    return () => release();
  }
  const orderCount = async () => Number((await t.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM orders`)[0]!.n);
  /** The attempt left CREATING by the superseded request is adopted by its receipt once it is a minute old (AT-03). */
  async function adoptStuckAttempt(orderNumber: string) {
    const o = await t.order(orderNumber);
    await t.prisma.paymentAttempt.updateMany({ where: { orderId: o.id, status: 'CREATING' }, data: { createdAt: new Date(Date.now() - 61_000) } });
    await reconcileAttempts(t.deps());
  }

  it('A stalls past its 1 s lock; B resumes the same order; A gets 409 REQUEST_SUPERSEDED and its work rolls back; retries settle on that order', async () => {
    const cart = await t.cartWith();
    const key = randomUUID();
    const before = await orderCount();
    const release = stallFirstCreate();
    const a = cart.initiate(key);                       // attaches its order, then hangs at Razorpay
    await sleep(1400);                                  // its lock expires
    const b = await cart.initiate(key);                 // TAKEOVER: resumes the attached order, never makes a second one
    expect([b.status, b.body.status]).toEqual([202, 'PAYMENT_STARTING']);
    release();
    const late = await a;
    expect([late.status, late.body.error?.code]).toEqual([409, 'REQUEST_SUPERSEDED']);
    expect(await orderCount()).toBe(before + 1);
    const o = await t.order(b.body.orderNumber);
    expect(o.paymentAttempts.map((x) => [x.status, x.providerOrderId])).toEqual([['CREATING', null]]);   // A's save of the provider order rolled back
    const receipt = o.paymentAttempts[0]!.receipt;
    expect(t.fake.orders.filter((x) => x.receipt === receipt)).toHaveLength(1);   // one provider order

    await adoptStuckAttempt(b.body.orderNumber);
    // The client retries as told (B said retryAfter); until the key is free again it is told to wait.
    let settled = await cart.initiate(key);
    for (let i = 0; i < 20 && settled.status === 409; i++) {
      expect(settled.body.error.code).toBe('REQUEST_IN_PROGRESS');
      await sleep(500);
      settled = await cart.initiate(key);
    }
    expect([settled.status, settled.body.orderNumber, settled.body.razorpay?.orderId]).toEqual([201, b.body.orderNumber, t.fake.orders.find((x) => x.receipt === receipt)!.id]);
    const replay = await cart.initiate(key);
    expect([replay.status, replay.headers['idempotent-replayed'], replay.body]).toEqual([201, 'true', settled.body]);
    expect(await orderCount()).toBe(before + 1);
  });

  it('five takeovers at once after the lock expires: exactly one owner, the rest wait; one order', async () => {
    const cart = await t.cartWith();
    const key = randomUUID();
    const before = await orderCount();
    const release = stallFirstCreate();
    const a = cart.initiate(key);
    await sleep(1400);
    const racers = await Promise.all(Array.from({ length: 5 }, () => cart.initiate(key)));
    release();
    expect((await a).body.error?.code).toBe('REQUEST_SUPERSEDED');
    const owners = racers.filter((r) => r.status === 202);
    expect(owners).toHaveLength(1);
    expect(racers.filter((r) => r.status === 409).map((r) => r.body.error.code)).toEqual(Array(4).fill('REQUEST_IN_PROGRESS'));
    expect(await orderCount()).toBe(before + 1);
    expect(owners[0]!.body.orderNumber).toMatch(/^AQ\d+$/);
  });
});
