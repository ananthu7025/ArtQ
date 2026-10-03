// Task 4.3: the coupon reservation lifecycle through the real aq_* functions (database.md §3.7):
// reserve (checkout) → redeem (capture) | release (expiry/cancel unpaid) → reverse (paid order cancelled, D-14),
// over-limit on a late capture, and AT-09 (10 concurrent checkouts on a limit-1 coupon; expiry never touches
// redeemed_count).
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbFunctionError } from '../../src/db/errors.js';
import * as fn from '../../src/db/functions.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { attempt, capture, catalog, one, order, tx, uniq, val, type OrderFixture } from '../helpers/fixtures.js';
import { startPostgres, type Service } from '../helpers/services.js';

let pg: Service, db: TestDb, prisma: PrismaClient;
beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });

const coupon = (limitTotal: number | null = null, perCustomer: number | null = 1) => val<number>(prisma,
  `INSERT INTO coupons (code, title, type, value, usage_limit_total, usage_limit_per_customer, updated_at) VALUES ($1,'t','FLAT',500,$2,$3,now()) RETURNING id`,
  'LC' + uniq().toUpperCase(), limitTotal, perCustomer);
const counts = (id: number) => one<{ reserved_count: number; redeemed_count: number }>(prisma, `SELECT reserved_count, redeemed_count FROM coupons WHERE id=$1`, id);
const redemption = (orderId: number) => one<{ status: string; over_limit: boolean }>(prisma, `SELECT status, over_limit FROM coupon_redemptions WHERE order_id=$1`, orderId);
async function orders(n: number, onHand = 100): Promise<OrderFixture[]> {
  const cat = await catalog(prisma, [[{ price: 10_000, onHand }]]);
  const out: OrderFixture[] = [];
  for (let i = 0; i < n; i++) out.push(await tx(prisma, (t) => order(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }], couponDiscount: 500 })));
  return out;
}
const reserve = (o: OrderFixture, couponId: number, email = `${uniq()}@x.in`) =>
  tx(prisma, (t) => fn.reserveCoupon(t, { orderId: o.orderId, couponId, userId: null, email, phone: null, discount: 500 }));
const pay = async (o: OrderFixture) => {
  const a = await tx(prisma, (t) => attempt(t, o.orderId, o.total));
  return tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: 'pay_' + uniq(), amount: o.total }));
};
const expire = (o: OrderFixture) => tx(prisma, (t) => fn.releaseUnpaidOrder(t, { orderId: o.orderId, newStatus: 'EXPIRED', reason: 'timeout', actor: 'SYSTEM' }));
/** The cancellation transaction's order step (the full cancel flow arrives with order management). */
const cancel = (o: OrderFixture) => prisma.$executeRawUnsafe(`UPDATE orders SET status='CANCELLED', cancelled_at=now(), cancel_reason='test', cancelled_by='ADMIN' WHERE id=$1`, o.orderId);

describe('AT-09: concurrent final use', () => {
  it('10 checkouts on a limit-1 coupon: one RESERVED, nine COUPON_USAGE_EXCEEDED; expiry releases without touching redeemed_count', async () => {
    const c = await coupon(1, null);
    const os = await orders(10);
    const r = await Promise.allSettled(os.map((o) => reserve(o, c)));
    const won = os.filter((_, i) => r[i]!.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const x of r.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
      expect(x.reason).toBeInstanceOf(DbFunctionError);
      expect((x.reason as DbFunctionError).message).toBe('COUPON_USAGE_EXCEEDED:total');
    }
    expect(await counts(c)).toEqual({ reserved_count: 1, redeemed_count: 0 });
    expect(await expire(won[0]!)).toBe('EXPIRED');
    expect(await redemption(won[0]!.orderId)).toEqual({ status: 'RELEASED', over_limit: false });
    expect(await counts(c)).toEqual({ reserved_count: 0, redeemed_count: 0 });
    expect(await expire(won[0]!)).toBe('SKIPPED');                                       // a second expiry changes nothing
    expect(await counts(c)).toEqual({ reserved_count: 0, redeemed_count: 0 });
  });

  it('expiring an unpaid order never decrements redeemed_count (another order already redeemed the coupon)', async () => {
    const c = await coupon(5, null);
    const [paid, unpaid] = await orders(2) as [OrderFixture, OrderFixture];
    await reserve(paid, c); await reserve(unpaid, c);
    expect(await pay(paid)).toBe('APPLIED');
    expect(await counts(c)).toEqual({ reserved_count: 1, redeemed_count: 1 });
    await expire(unpaid);
    expect(await counts(c)).toEqual({ reserved_count: 0, redeemed_count: 1 });
  });
});

describe('redeem, release, reverse', () => {
  it('capture redeems once (a repeated webhook does not count twice)', async () => {
    const c = await coupon();
    const [o] = await orders(1) as [OrderFixture];
    await reserve(o, c);
    const a = await tx(prisma, (t) => attempt(t, o.orderId, o.total));
    const payId = 'pay_' + uniq();
    expect(await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: payId, amount: o.total }))).toBe('APPLIED');
    expect(await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: payId, amount: o.total }))).toBe('DUPLICATE');
    expect(await redemption(o.orderId)).toEqual({ status: 'REDEEMED', over_limit: false });
    expect(await counts(c)).toEqual({ reserved_count: 0, redeemed_count: 1 });
  });

  it('a cancelled paid order gets the use back (D-14), once; the customer can use the coupon again', async () => {
    const c = await coupon(1, 1);
    const [o, again] = await orders(2) as [OrderFixture, OrderFixture];
    await reserve(o, c, 'asha@x.in');
    await pay(o);
    await expect(reserve(again, c, 'ASHA@x.in')).rejects.toThrow('COUPON_USAGE_EXCEEDED:customer');
    await cancel(o);
    expect(await tx(prisma, (t) => fn.reverseCoupon(t, o.orderId))).toBe(true);
    expect(await tx(prisma, (t) => fn.reverseCoupon(t, o.orderId))).toBe(false);   // retried: nothing moves twice
    expect(await redemption(o.orderId)).toEqual({ status: 'REVERSED', over_limit: false });
    expect(await counts(c)).toEqual({ reserved_count: 0, redeemed_count: 0 });
    await reserve(again, c, 'asha@x.in');                                              // capacity and per-customer use restored
  });

  it('reversal refuses an order that is not cancelled, and does nothing for an order without a redeemed coupon', async () => {
    const c = await coupon();
    const [o, plain] = await orders(2) as [OrderFixture, OrderFixture];
    await reserve(o, c);
    await pay(o);
    const e = await tx(prisma, (t) => fn.reverseCoupon(t, o.orderId)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DbFunctionError);
    expect((e as DbFunctionError).code).toBe('INVARIANT');
    expect(await counts(c)).toEqual({ reserved_count: 0, redeemed_count: 1 });
    await cancel(plain);
    expect(await tx(prisma, (t) => fn.reverseCoupon(t, plain.orderId))).toBe(false);
    await expect(tx(prisma, (t) => fn.reverseCoupon(t, 999_999))).rejects.toThrow('NOT_FOUND');
  });
});

describe('over-limit (late capture after the last use was taken)', () => {
  it('honoured, flagged COUPON_OVER_LIMIT, kept out of the counters; reversing it later never goes below zero', async () => {
    const c = await coupon(1, null);
    const [late, other] = await orders(2) as [OrderFixture, OrderFixture];
    await reserve(late, c);
    const a = await tx(prisma, (t) => attempt(t, late.orderId, late.total));
    await expire(late);                                                                // the last use is free again…
    await reserve(other, c);                                                           // …and someone else takes it
    expect(await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: 'pay_' + uniq(), amount: late.total }))).toBe('APPLIED');
    expect(await redemption(late.orderId)).toEqual({ status: 'REDEEMED', over_limit: true });
    expect(await counts(c)).toEqual({ reserved_count: 1, redeemed_count: 0 });
    expect(await one(prisma, `SELECT type, status FROM payment_exceptions WHERE dedupe_key = $1`, `COUPON_OVER_LIMIT:${late.orderId}`)).toEqual({ type: 'COUPON_OVER_LIMIT', status: 'OPEN' });
    await cancel(late);
    expect(await tx(prisma, (t) => fn.reverseCoupon(t, late.orderId))).toBe(true);
    expect(await counts(c)).toEqual({ reserved_count: 1, redeemed_count: 0 });
  });

  it('a late capture with capacity left re-redeems normally (not over-limit)', async () => {
    const c = await coupon(2, null);
    const [late] = await orders(1) as [OrderFixture];
    await reserve(late, c);
    const a = await tx(prisma, (t) => attempt(t, late.orderId, late.total));
    await expire(late);
    await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: 'pay_' + uniq(), amount: late.total }));
    expect(await redemption(late.orderId)).toEqual({ status: 'REDEEMED', over_limit: false });
    expect(await counts(c)).toEqual({ reserved_count: 0, redeemed_count: 1 });
  });
});
