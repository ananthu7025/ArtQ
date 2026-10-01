// Task 1.1 acceptance (publish gate, refund cap, snapshot/invoice immutability, coupon capacity, category/type FK)
// plus happy/negative/concurrency paths through every group of typed wrappers, on a database built by the real migrations.
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbFunctionError, rethrowDbError } from '../../src/db/errors.js';
import * as fn from '../../src/db/functions.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { attempt, capture, catalog, one, order, race, tx, uniq, val, type OrderFixture } from '../helpers/fixtures.js';
import { startPostgres, type Service } from '../helpers/services.js';

let pg: Service, db: TestDb, prisma: PrismaClient;
beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });

/** Asserts a DbFunctionError with the given code (and detail, when given). */
async function rejectsWith(p: Promise<unknown>, code: string, detail?: string) {
  const e = await p.then(() => undefined, (err: unknown) => err);
  expect(e, `expected ${code}`).toBeInstanceOf(DbFunctionError);
  expect((e as DbFunctionError).code).toBe(code);
  if (detail !== undefined) expect((e as DbFunctionError).detail).toBe(detail);
}

const hash = (s: string) => s.padEnd(64, '0').slice(0, 64);

describe('acceptance: publish gate', () => {
  it('blocks publishing until tax, weight, counted stock and a READY cover image exist; drift view catches later breakage', async () => {
    const cat = await catalog(prisma, [[{ price: 1000, onHand: 5 }]]);
    const p = cat.products[0]!.productId, v = cat.products[0]!.variantIds[0]!;
    // Plain statement (not a wrapper): services map trigger errors with rethrowDbError the same way.
    const publish = () => prisma.$executeRawUnsafe(`UPDATE products SET status='ACTIVE', is_publishable=true, published_at=now() WHERE id=$1`, p)
      .catch(rethrowDbError);

    await rejectsWith(publish(), 'NOT_PUBLISHABLE');
    await prisma.$executeRawUnsafe(`UPDATE products SET hsn_code='3907', gst_rate=18, tax_approved_at=now() WHERE id=$1`, p);
    await prisma.$executeRawUnsafe(`UPDATE product_variants SET weight_g=350, weight_source='MEASURED' WHERE id=$1`, v);
    await fn.adjustOnHand(prisma, { rows: [{ variantId: v, kind: 'RECOUNT', quantity: 5 }], actorId: null });
    await rejectsWith(publish(), 'NOT_PUBLISHABLE', 'no_image');

    const media = await val<number>(prisma, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, updated_at)
      VALUES ($1,'PUBLIC','IMAGE','image/webp',10,'admin','PROCESSING',now()) RETURNING id`, 'k' + uniq());
    await prisma.$executeRawUnsafe(`INSERT INTO product_images (product_id, media_id, is_cover) VALUES ($1,$2,true)`, p, media);
    await rejectsWith(publish(), 'NOT_PUBLISHABLE', 'no_image');      // PROCESSING is not ready
    await prisma.$executeRawUnsafe(`UPDATE media SET status='READY' WHERE id=$1`, media);
    expect(await publish()).toBe(1);

    await prisma.$executeRawUnsafe(`UPDATE media SET status='FAILED' WHERE id=$1`, media);
    expect(await val(prisma, `SELECT count(*)::int FROM published_not_ready WHERE id=$1`, p)).toBe(1);
  });
});

describe('acceptance: category must belong to the product type', () => {
  it('rejects a product whose category belongs to another type (composite FK)', async () => {
    const a = await catalog(prisma, [[{}]]);
    const b = await catalog(prisma, [[{}]]);
    const insert = (typeId: number, categoryId: number) => prisma.$executeRawUnsafe(
      `INSERT INTO products (type_id, category_id, name, slug, description, updated_at) VALUES ($1,$2,$3,$3,'d',now())`, typeId, categoryId, 'x' + uniq());
    await expect(insert(a.typeId, b.categoryId)).rejects.toThrow(/products_category_matches_type_fk/);
    await expect(insert(a.typeId, a.categoryId)).resolves.toBe(1);
    await expect(prisma.$executeRawUnsafe(`UPDATE products SET category_id=$2 WHERE id=$1`, a.products[0]!.productId, b.categoryId))
      .rejects.toThrow(/products_category_matches_type_fk/);
  });
});

describe('acceptance: refund capacity', () => {
  it('8 concurrent ₹600 refunds on a ₹1,000 item: exactly one is accepted; shipping refundable once', async () => {
    const cat = await catalog(prisma, [[{ price: 50_000, onHand: 10 }, { price: 50_000, onHand: 10 }]]);
    const [v1, v2] = cat.products[0]!.variantIds as [number, number];
    const O = await tx(prisma, (t) => order(t, { lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 2 }], shippingFee: 6000 }));
    const a = await attempt(prisma, O.orderId, O.total);
    expect(await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: 'pay_' + uniq(), amount: O.total }))).toBe('APPLIED');
    const pay = await val<number>(prisma, `SELECT id FROM payments WHERE order_id=$1`, O.orderId);
    const req = (items: fn.RefundItemInput[], shipping = 0) => tx(prisma, (t) => fn.requestRefund(t, {
      orderId: O.orderId, paymentId: pay, kind: 'RETURN', items, shipping, codFee: 0, unallocated: 0, reason: 't', idempotencyKey: uniq(), requestedBy: null,
    }));

    const r1 = await race(8, () => req([{ orderItemId: O.items[0]!.orderItemId, quantity: 1, amount: 60_000 }]));
    expect(r1.ok).toBe(1);
    expect(r1.errors).toEqual([`REFUND_EXCEEDS_CAPACITY:item:${O.items[0]!.orderItemId}`]);
    const r2 = await race(6, () => req([], 6000));
    expect(r2.ok).toBe(1);
    expect(await one(prisma, `SELECT refund_reserved_total, refund_reserved_shipping FROM orders WHERE id=$1`, O.orderId))
      .toEqual({ refund_reserved_total: 66_000, refund_reserved_shipping: 6000 });

    await rejectsWith(req([], 0), 'REFUND_AMOUNT_INVALID');
    await rejectsWith(tx(prisma, (t) => fn.requestRefund(t, { orderId: O.orderId, paymentId: 999_999, kind: 'RETURN', items: [], shipping: 100,
      codFee: 0, unallocated: 0, reason: 't', idempotencyKey: uniq(), requestedBy: null })), 'REFUND_PAYMENT_INVALID');
  });

  it('COD manual refunds: rejected before collection; cancel releases capacity once; online refunds are not cancellable', async () => {
    const cat = await catalog(prisma, [[{ price: 50_000, onHand: 5 }]]);
    const v = cat.products[0]!.variantIds[0]!;
    const C = await tx(prisma, (t) => order(t, { lines: [{ variantId: v, qty: 1 }], method: 'COD', codFee: 4000 }));
    const req = () => tx(prisma, (t) => fn.requestRefund(t, { orderId: C.orderId, paymentId: null, kind: 'RETURN',
      items: [{ orderItemId: C.items[0]!.orderItemId, quantity: 1, amount: 50_000 }], shipping: 0, codFee: 4000, unallocated: 0, reason: 't',
      idempotencyKey: uniq(), requestedBy: null }));
    await rejectsWith(req(), 'REFUND_PAYMENT_INVALID', 'cod');
    await prisma.$executeRawUnsafe(`UPDATE orders SET payment_status='COD_COLLECTED' WHERE id=$1`, C.orderId);
    const r = await race(5, req);
    expect(r.ok).toBe(1);
    const refund = await val<number>(prisma, `SELECT id FROM refunds WHERE order_id=$1`, C.orderId);
    expect(await fn.newRefundAttempt(prisma, refund)).toBeNull();          // manual refunds never call the provider
    await tx(prisma, (t) => fn.cancelManualRefund(t, refund));
    expect(await val(prisma, `SELECT refund_reserved_total FROM orders WHERE id=$1`, C.orderId)).toBe(0);
    await rejectsWith(tx(prisma, (t) => fn.cancelManualRefund(t, refund)), 'REFUND_NOT_CANCELLABLE');
  });
});

describe('acceptance: snapshot and invoice immutability', () => {
  it('order item snapshot columns and invoices cannot be changed or deleted', async () => {
    const cat = await catalog(prisma, [[{ price: 1000 }]]);
    const O = await tx(prisma, (t) => order(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }], reserve: false }));
    await expect(prisma.$executeRawUnsafe(`UPDATE order_items SET unit_price=1 WHERE order_id=$1`, O.orderId)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`UPDATE order_items SET product_name='renamed' WHERE order_id=$1`, O.orderId)).rejects.toThrow(/immutable/);
    const seq = 100_000 + Math.floor(Math.random() * 900_000);
    const inv = await val<number>(prisma, `INSERT INTO invoices (order_id, kind, number, fy, seq, issued_at, seller_snapshot, buyer_snapshot, place_of_supply, lines,
        taxable_total, cgst_total, sgst_total, igst_total, grand_total)
      VALUES ($1,'TAX_INVOICE',$2,'26-27',$3,now(),'{}','{}','32','[]',847,77,76,0,1000) RETURNING id`, O.orderId, `AQ/26-27/${String(seq).padStart(6, '0')}`, seq);
    await expect(prisma.$executeRawUnsafe(`UPDATE invoices SET grand_total=1 WHERE id=$1`, inv)).rejects.toThrow(/immutable .*credit note/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM invoices WHERE id=$1`, inv)).rejects.toThrow(/invoices are immutable/);
    // the only allowed change: attaching the rendered PDF, once
    const pdf = () => val<number>(prisma, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, updated_at)
      VALUES ($1,'PRIVATE','DOCUMENT','application/pdf',10,'system','READY',now()) RETURNING id`, 'inv' + uniq());
    await expect(prisma.$executeRawUnsafe(`UPDATE invoices SET pdf_media_id=$2 WHERE id=$1`, inv, await pdf())).resolves.toBe(1);
    await expect(prisma.$executeRawUnsafe(`UPDATE invoices SET pdf_media_id=$2 WHERE id=$1`, inv, await pdf())).rejects.toThrow(/credit note/);
    expect(await val(prisma, `SELECT grand_total FROM invoices WHERE id=$1`, inv)).toBe(1000);
  });
});

describe('acceptance: coupon capacity', () => {
  const coupon = (extra = '', limitTotal: number | null = null, perCustomer: number | null = null) => val<number>(prisma,
    `INSERT INTO coupons (code, title, type, value, usage_limit_total, usage_limit_per_customer, updated_at${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES ($1,'x','FLAT',100,$2,$3,now()${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`, 'C' + uniq().toUpperCase(), limitTotal, perCustomer);
  const orders = async (n: number) => {
    const cat = await catalog(prisma, [[{ price: 1000, onHand: 100 }]]);
    return Promise.all(Array.from({ length: n }, () => tx(prisma, (t) => order(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }], reserve: false }))));
  };
  const reserve = (orderId: number, couponId: number, email: string) =>
    tx(prisma, (t) => fn.reserveCoupon(t, { orderId, couponId, userId: null, email, phone: null, discount: 100 }));

  it('the final use of a limited coupon is granted exactly once under 10 concurrent checkouts', async () => {
    const c = await coupon('', 1);
    const os = await orders(10);
    const r = await Promise.allSettled(os.map((o, i) => reserve(o.orderId, c, `u${i}@x.in`)));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const errs = r.filter((x): x is PromiseRejectedResult => x.status === 'rejected').map((x) => (x.reason as DbFunctionError).message);
    expect(new Set(errs)).toEqual(new Set(['COUPON_USAGE_EXCEEDED:total']));
    expect(await one(prisma, `SELECT reserved_count, redeemed_count FROM coupons WHERE id=$1`, c)).toEqual({ reserved_count: 1, redeemed_count: 0 });
  });

  it('per-customer limit, inactive and expired coupons are rejected; release returns capacity', async () => {
    const [o1, o2, o3] = (await orders(3)) as [OrderFixture, OrderFixture, OrderFixture];
    const per = await coupon('', null, 1);
    await reserve(o1.orderId, per, 'same@x.in');
    await rejectsWith(reserve(o2.orderId, per, 'SAME@x.in'), 'COUPON_USAGE_EXCEEDED', 'customer');   // citext: case-insensitive
    await rejectsWith(reserve(o2.orderId, await coupon('is_active=false'), 'a@x.in'), 'COUPON_INVALID');
    await rejectsWith(reserve(o2.orderId, await coupon(`ends_at=now() - interval '1 minute'`), 'a@x.in'), 'COUPON_INVALID');
    await rejectsWith(reserve(o2.orderId, 999_999, 'a@x.in'), 'COUPON_INVALID');

    const once = await coupon('', 1);
    await reserve(o2.orderId, once, 'b@x.in');
    expect(await tx(prisma, (t) => fn.releaseUnpaidOrder(t, { orderId: o2.orderId, newStatus: 'EXPIRED', reason: 'timeout', actor: 'SYSTEM' }))).toBe('EXPIRED');
    await reserve(o3.orderId, once, 'c@x.in');                                                         // capacity came back
  });
});

describe('stock: reserve, release, adjust', () => {
  it('12 concurrent checkouts on 5 units: exactly 5 succeed; OUT_OF_STOCK names the variant', async () => {
    const cat = await catalog(prisma, [[{ price: 1000, onHand: 5 }]]);
    const v = cat.products[0]!.variantIds[0]!;
    const r = await race(12, () => tx(prisma, (t) => order(t, { lines: [{ variantId: v, qty: 1 }] })));
    expect(r.ok).toBe(5);
    expect(r.errors).toEqual([`OUT_OF_STOCK:${v}`]);
    expect(await one(prisma, `SELECT on_hand, reserved FROM product_variants WHERE id=$1`, v)).toEqual({ on_hand: 5, reserved: 5 });
    expect(await val(prisma, `SELECT available_qty FROM products WHERE id=$1`, cat.products[0]!.productId)).toBe(0);
  });

  it('release returns stock once; a second release and non-unpaid orders are SKIPPED; bad status is rejected', async () => {
    const cat = await catalog(prisma, [[{ price: 1000, onHand: 3 }]]);
    const v = cat.products[0]!.variantIds[0]!;
    const O = await tx(prisma, (t) => order(t, { lines: [{ variantId: v, qty: 3 }] }));
    const rel = (status: 'EXPIRED' | 'CANCELLED') => tx(prisma, (t) => fn.releaseUnpaidOrder(t, { orderId: O.orderId, newStatus: status, reason: 'r', actor: 'CUSTOMER' }));
    expect(await rel('CANCELLED')).toBe('CANCELLED');
    expect(await rel('CANCELLED')).toBe('SKIPPED');
    expect(await val(prisma, `SELECT reserved FROM product_variants WHERE id=$1`, v)).toBe(0);
    expect(await one(prisma, `SELECT status::text, cancelled_by::text FROM orders WHERE id=$1`, O.orderId)).toEqual({ status: 'CANCELLED', cancelled_by: 'CUSTOMER' });
    await expect(tx(prisma, (t) => fn.releaseUnpaidOrder(t, { orderId: O.orderId, newStatus: 'PLACED' as 'EXPIRED', reason: 'r', actor: 'SYSTEM' })))
      .rejects.toThrow(/bad status PLACED/);
  });

  it('reacquire is all-or-nothing', async () => {
    const cat = await catalog(prisma, [[{ price: 1000, onHand: 2 }, { price: 1000, onHand: 1 }]]);
    const [v1, v2] = cat.products[0]!.variantIds as [number, number];
    const O = await tx(prisma, (t) => order(t, { lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }] }));
    await tx(prisma, (t) => fn.releaseUnpaidOrder(t, { orderId: O.orderId, newStatus: 'EXPIRED', reason: 'timeout', actor: 'SYSTEM' }));
    await tx(prisma, (t) => order(t, { lines: [{ variantId: v2, qty: 1 }] }));          // someone takes the last v2
    expect(await tx(prisma, (t) => fn.reacquireOrder(t, O.orderId))).toBe(false);
    expect(await val(prisma, `SELECT reserved FROM product_variants WHERE id=$1`, v1)).toBe(0);   // v1 not half-reserved
    await fn.adjustOnHand(prisma, { rows: [{ variantId: v2, kind: 'ADJUSTMENT', quantity: 1 }], actorId: null });
    expect(await tx(prisma, (t) => fn.reacquireOrder(t, O.orderId))).toBe(true);
  });

  it('adjustOnHand: recount/adjust/write-off; negative result and unknown variant rejected atomically; oversold raises an exception', async () => {
    const cat = await catalog(prisma, [[{ price: 1000, onHand: 10 }]]);
    const v = cat.products[0]!.variantIds[0]!;
    const onHand = () => val<number>(prisma, `SELECT on_hand FROM product_variants WHERE id=$1`, v);
    await fn.adjustOnHand(prisma, { rows: [{ variantId: v, kind: 'RECOUNT', quantity: 7 }], actorId: null });
    await fn.adjustOnHand(prisma, { rows: [{ variantId: v, kind: 'ADJUSTMENT', quantity: -2, note: 'found damaged' }], actorId: null });
    await fn.adjustOnHand(prisma, { rows: [{ variantId: v, kind: 'DAMAGE_WRITE_OFF', quantity: -1 }], actorId: null });   // abs() applied
    expect(await onHand()).toBe(4);
    await rejectsWith(fn.adjustOnHand(prisma, { rows: [{ variantId: v, kind: 'ADJUSTMENT', quantity: -5 }], actorId: null }), 'INVALID_ADJUSTMENT', String(v));
    await rejectsWith(tx(prisma, (t) => fn.adjustOnHand(t, { rows: [{ variantId: v, kind: 'RECOUNT', quantity: 1 }, { variantId: 999_999, kind: 'RECOUNT', quantity: 1 }], actorId: null })),
      'NOT_FOUND', 'variant:999999');
    expect(await onHand()).toBe(4);                                                  // the whole batch rolled back
    await tx(prisma, (t) => order(t, { lines: [{ variantId: v, qty: 4 }] }));
    await fn.adjustOnHand(prisma, { rows: [{ variantId: v, kind: 'RECOUNT', quantity: 1 }], actorId: null });
    expect(await val(prisma, `SELECT count(*)::int FROM payment_exceptions WHERE type='OVERSOLD' AND details->>'variant_id' = $1`, String(v))).toBe(1);
  });

  it('editVariants updates only the given product; processSearchQueue drains the queue', async () => {
    const cat = await catalog(prisma, [[{}, {}]]);
    const [v1, v2] = cat.products[0]!.variantIds as [number, number];
    await fn.editVariants(prisma, cat.products[0]!.productId, [{ variantId: v1, color: 'Gold' }, { variantId: v2, isActive: false }]);
    expect(await one(prisma, `SELECT color, is_active FROM product_variants WHERE id=$1`, v1)).toEqual({ color: 'Gold', is_active: true });
    expect(await val(prisma, `SELECT active_variant_count FROM products WHERE id=$1`, cat.products[0]!.productId)).toBe(1);
    const other = await catalog(prisma, [[{}]]);
    await fn.editVariants(prisma, other.products[0]!.productId, [{ variantId: v1, color: 'Silver' }]);   // wrong product: no effect
    expect(await val(prisma, `SELECT color FROM product_variants WHERE id=$1`, v1)).toBe('Gold');
    expect(await fn.processSearchQueue(prisma, 10_000)).toBeGreaterThan(0);
    expect(await fn.processSearchQueue(prisma)).toBe(0);
  });
});

describe('payments', () => {
  it('applies a capture once, reports DUPLICATE on replay and UNLINKED for an unknown provider order', async () => {
    const cat = await catalog(prisma, [[{ price: 2000, onHand: 5 }]]);
    const O = await tx(prisma, (t) => order(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }] }));
    const a = await attempt(prisma, O.orderId, O.total);
    const payId = 'pay_' + uniq();
    expect(await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: payId, amount: O.total }))).toBe('APPLIED');
    expect(await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: payId, amount: O.total }))).toBe('DUPLICATE');
    expect(await one(prisma, `SELECT status::text, payment_status::text FROM orders WHERE id=$1`, O.orderId)).toEqual({ status: 'PLACED', payment_status: 'PAID' });
    expect(await tx(prisma, (t) => fn.reassessOrderPayment(t, O.orderId, 'SYSTEM'))).toBe('UNCHANGED');
    expect(await tx(prisma, (t) => capture(t, { providerOrderId: 'order_unknown_' + uniq(), paymentId: 'pay_' + uniq(), amount: 100 }))).toBe('UNLINKED');
  });

  it('rejects invalid provider snapshots with the database error (not a business code)', async () => {
    const bad = tx(prisma, (t) => fn.applyProviderPayment(t, { providerOrderId: 'x', paymentId: 'y', amount: 100, currency: 'INR',
      status: 'SETTLED' as fn.ProviderPaymentStatus, amountRefunded: 0, capturedAt: null, method: null, raw: {}, actor: 'WEBHOOK' }));
    await expect(bad).rejects.toThrow(/unknown provider status SETTLED/);
    await expect(bad).rejects.not.toBeInstanceOf(DbFunctionError);
    await expect(tx(prisma, (t) => capture(t, { providerOrderId: 'x', paymentId: 'y', amount: 100, amountRefunded: 101 })))
      .rejects.toThrow(/invalid provider amount_refunded 101/);
  });
});

describe('refund lifecycle', () => {
  async function paidOrder() {
    const cat = await catalog(prisma, [[{ price: 10_000, onHand: 5 }]]);
    const O = await tx(prisma, (t) => order(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }] }));
    const a = await attempt(prisma, O.orderId, O.total);
    await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: 'pay_' + uniq(), amount: O.total }));
    const pay = await val<number>(prisma, `SELECT id FROM payments WHERE order_id=$1`, O.orderId);
    const refundId = await tx(prisma, (t) => fn.requestRefund(t, { orderId: O.orderId, paymentId: pay, kind: 'CANCELLATION',
      items: [{ orderItemId: O.items[0]!.orderItemId, quantity: 1, amount: 10_000 }], shipping: 0, codFee: 0, unallocated: 0, reason: 'r', idempotencyKey: uniq(), requestedBy: null }));
    const attemptId = await val<number>(prisma, `SELECT id FROM refund_attempts WHERE refund_id=$1 ORDER BY attempt_no DESC LIMIT 1`, refundId);
    return { O, pay, refundId, attemptId };
  }

  it('accepted → processed once; order becomes REFUNDED', async () => {
    const { O, refundId, attemptId } = await paidOrder();
    expect(await tx(prisma, (t) => fn.refundAttemptResult(t, { attemptId, outcome: 'ACCEPTED_PENDING', httpStatus: 200, response: { id: 'rfnd_1' }, providerRefundId: 'rfnd_' + uniq() }))).toBe('PENDING');
    expect(await tx(prisma, (t) => fn.markRefundProcessed(t, refundId, null))).toBe('PROCESSED');
    expect(await tx(prisma, (t) => fn.markRefundProcessed(t, refundId, null))).toBe('DUPLICATE');
    expect(await val(prisma, `SELECT payment_status::text FROM orders WHERE id=$1`, O.orderId)).toBe('REFUNDED');
    expect(await tx(prisma, (t) => fn.refundAttemptResult(t, { attemptId, outcome: 'FAILED', httpStatus: 400, response: {}, providerRefundId: null }))).toBe('STALE');
  });

  it('failure releases capacity; retry reacquires it with a new attempt; only FAILED refunds are retryable', async () => {
    const { O, refundId, attemptId } = await paidOrder();
    await rejectsWith(tx(prisma, (t) => fn.retryRefund(t, refundId)), 'REFUND_NOT_RETRYABLE');
    expect(await tx(prisma, (t) => fn.refundAttemptResult(t, { attemptId, outcome: 'FAILED', httpStatus: 400, response: { description: 'declined' }, providerRefundId: null }))).toBe('FAILED');
    expect(await val(prisma, `SELECT refund_reserved_total FROM orders WHERE id=$1`, O.orderId)).toBe(0);
    expect(await val(prisma, `SELECT count(*)::int FROM payment_exceptions WHERE type='REFUND_FAILED' AND refund_id=$1`, refundId)).toBe(1);
    expect(await tx(prisma, (t) => fn.retryRefund(t, refundId))).toBe(2);
    expect(await val(prisma, `SELECT refund_reserved_total FROM orders WHERE id=$1`, O.orderId)).toBe(10_000);
    expect(await val(prisma, `SELECT count(*)::int FROM refund_attempts WHERE refund_id=$1`, refundId)).toBe(2);
  });

  it('unknown outcome keeps capacity; mismatch raises an exception; reconcile handles unbound and matching provider lists', async () => {
    const { pay, refundId, attemptId } = await paidOrder();
    expect(await tx(prisma, (t) => fn.refundAttemptResult(t, { attemptId, outcome: 'UNKNOWN', httpStatus: 504, response: {}, providerRefundId: null }))).toBe('UNKNOWN');
    expect(await tx(prisma, (t) => fn.refundAttemptResult(t, { attemptId, outcome: 'MISMATCH', httpStatus: 400, response: {}, providerRefundId: null }))).toBe('MISMATCH');
    expect(await val(prisma, `SELECT count(*)::int FROM payment_exceptions WHERE type='REFUND_IDEMPOTENCY_MISMATCH' AND refund_id=$1`, refundId)).toBe(1);
    const receipt = await val<string>(prisma, `SELECT receipt FROM refund_attempts WHERE id=$1`, attemptId);
    expect(await tx(prisma, (t) => fn.reconcileProviderRefunds(t, pay, [{ id: 'rfnd_' + uniq(), amount: 10_000, status: 'processed', receipt }]))).toBe('RECONCILED');
    expect(await val(prisma, `SELECT status::text FROM refunds WHERE id=$1`, refundId)).toBe('PROCESSED');

    await tx(prisma, (t) => capture(t, { providerOrderId: 'order_unknown_' + uniq(), paymentId: 'pay_unl_' + uniq(), amount: 500 }));
    const unlinked = await val<number>(prisma, `SELECT id FROM payments WHERE order_id IS NULL ORDER BY id DESC LIMIT 1`);
    expect(await tx(prisma, (t) => fn.reconcileProviderRefunds(t, unlinked, []))).toBe('UNBOUND');
  });

  it('refundCapacity wrapper enforces the same cap when called directly', async () => {
    const { refundId } = await paidOrder();
    await rejectsWith(tx(prisma, (t) => fn.refundCapacity(t, refundId, 1)), 'REFUND_EXCEEDS_CAPACITY');
  });
});

describe('idempotency keys', () => {
  const key = () => ({ scope: 'customer:1', operation: 'checkout.initiate', key: 'k-' + uniq() });

  it('NEW → attach → complete → REPLAY with the stored response; different body → CONFLICT', async () => {
    const k = key();
    const b = await fn.idempotencyBegin(prisma, { ...k, target: 'cart:1', requestHash: hash('a') });
    expect(b).toMatchObject({ outcome: 'NEW', generation: 1 });
    if (b.outcome !== 'NEW') throw new Error('unreachable');
    expect(await fn.idempotencyBegin(prisma, { ...k, target: 'cart:1', requestHash: hash('a') })).toEqual({ outcome: 'IN_PROGRESS', responseCode: 409 });
    await tx(prisma, async (t) => {
      await fn.idempotencyAssertOwner(t, { ...k, ownerToken: b.ownerToken });
      await fn.idempotencyAttach(t, { ...k, ownerToken: b.ownerToken, resourceType: 'order', resourceId: 'AQ1' });
    });
    expect(await fn.idempotencyRenew(prisma, { ...k, ownerToken: b.ownerToken })).toBe(true);
    await fn.idempotencyComplete(prisma, { ...k, ownerToken: b.ownerToken, responseCode: 201, responseBody: { orderNumber: 'AQ1' } });
    expect(await fn.idempotencyBegin(prisma, { ...k, target: 'cart:1', requestHash: hash('a') }))
      .toEqual({ outcome: 'REPLAY', responseCode: 201, responseBody: { orderNumber: 'AQ1' }, resourceType: 'order', resourceId: 'AQ1' });
    expect(await fn.idempotencyBegin(prisma, { ...k, target: 'cart:1', requestHash: hash('b') })).toEqual({ outcome: 'CONFLICT', responseCode: 422 });
    expect(await fn.idempotencyBegin(prisma, { ...k, target: 'cart:2', requestHash: hash('a') })).toEqual({ outcome: 'CONFLICT', responseCode: 422 });
    await rejectsWith(fn.idempotencyComplete(prisma, { ...k, ownerToken: b.ownerToken, responseCode: 201, responseBody: {} }), 'IDEMPOTENCY_OWNERSHIP_LOST', k.key);
  });

  it('TAKEOVER after the lock expires fences out the stale owner', async () => {
    const k = key();
    const first = await fn.idempotencyBegin(prisma, { ...k, target: 'cart:1', requestHash: hash('a'), lockSeconds: 0 });
    if (first.outcome !== 'NEW') throw new Error('expected NEW');
    await tx(prisma, (t) => fn.idempotencyAttach(t, { ...k, ownerToken: first.ownerToken, resourceType: 'order', resourceId: 'AQ9' }));
    const second = await fn.idempotencyBegin(prisma, { ...k, target: 'cart:1', requestHash: hash('a') });
    expect(second).toMatchObject({ outcome: 'TAKEOVER', generation: 2, resourceType: 'order', resourceId: 'AQ9' });
    await rejectsWith(tx(prisma, (t) => fn.idempotencyAssertOwner(t, { ...k, ownerToken: first.ownerToken })), 'IDEMPOTENCY_OWNERSHIP_LOST');
    await rejectsWith(fn.idempotencyAttach(prisma, { ...k, ownerToken: first.ownerToken, resourceType: 'order', resourceId: 'X' }), 'IDEMPOTENCY_OWNERSHIP_LOST');
    expect(await fn.idempotencyRenew(prisma, { ...k, ownerToken: first.ownerToken })).toBe(false);
    if (second.outcome !== 'TAKEOVER') throw new Error('unreachable');
    await fn.idempotencyComplete(prisma, { ...k, ownerToken: second.ownerToken, responseCode: 201, responseBody: { ok: true } });
  });

  it('a stale owner cannot commit its domain change: assert_owner rolls back the whole transaction', async () => {
    const k = key();
    const first = await fn.idempotencyBegin(prisma, { ...k, target: 't', requestHash: hash('a'), lockSeconds: 0 });
    await fn.idempotencyBegin(prisma, { ...k, target: 't', requestHash: hash('a') });          // takeover
    if (first.outcome !== 'NEW') throw new Error('expected NEW');
    const marker = 'stale-' + uniq();
    await rejectsWith(tx(prisma, async (t) => {
      await t.$executeRawUnsafe(`INSERT INTO settings (key, value, updated_at) VALUES ($1, '{}', now())`, marker);
      await fn.idempotencyAssertOwner(t, { ...k, ownerToken: first.ownerToken });
    }), 'IDEMPOTENCY_OWNERSHIP_LOST');
    expect(await val(prisma, `SELECT count(*)::int FROM settings WHERE key=$1`, marker)).toBe(0);
  });

  it('only one of 10 concurrent first requests becomes the owner', async () => {
    const k = key();
    const results = await Promise.all(Array.from({ length: 10 }, () => fn.idempotencyBegin(prisma, { ...k, target: 't', requestHash: hash('a') })));
    expect(results.filter((r) => r.outcome === 'NEW')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'IN_PROGRESS')).toHaveLength(9);
  });
});

describe('webhook inbox leases', () => {
  const event = () => val<number>(prisma, `INSERT INTO webhook_events (provider, event_id, event_type, payload) VALUES ('razorpay',$1,'payment.captured','{}') RETURNING id`, 'evt_' + uniq());

  it('claim → begin → renew → complete; second claim gets nothing; completing twice raises LEASE_LOST', async () => {
    const id = await event();
    const token = await fn.webhookClaim(prisma, id);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await fn.webhookClaim(prisma, id)).toBeNull();
    expect(await tx(prisma, (t) => fn.webhookBegin(t, id, token!))).toBe(true);
    expect(await fn.webhookBegin(prisma, id, '00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(await fn.webhookRenew(prisma, id, token!)).toBe(true);
    await tx(prisma, (t) => fn.webhookComplete(t, id, token!));
    expect(await val(prisma, `SELECT status::text FROM webhook_events WHERE id=$1`, id)).toBe('PROCESSED');
    await rejectsWith(fn.webhookComplete(prisma, id, token!), 'LEASE_LOST', `webhook:${id}`);
    expect(await fn.webhookRenew(prisma, id, token!)).toBe(false);
  });

  it('an expired lease is reclaimed; the stale worker can neither complete nor fail it', async () => {
    const id = await event();
    const stale = await fn.webhookClaim(prisma, id, 0);
    const fresh = await fn.webhookClaim(prisma, id);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(stale);
    expect(await fn.webhookFail(prisma, id, stale!, 'late')).toBe('LEASE_LOST');
    await rejectsWith(fn.webhookComplete(prisma, id, stale!), 'LEASE_LOST');
    expect(await fn.webhookFail(prisma, id, fresh!, 'boom')).toBe('FAILED');
    expect(await one(prisma, `SELECT status::text, last_error FROM webhook_events WHERE id=$1`, id)).toEqual({ status: 'FAILED', last_error: 'boom' });
    expect(await fn.webhookClaim(prisma, id)).toBeNull();                         // backoff: not due yet
  });

  it('the 10th failure is DEAD and raises one WEBHOOK_DEAD exception; IGNORED is a valid final state', async () => {
    const id = await event();
    await prisma.$executeRawUnsafe(`UPDATE webhook_events SET attempts=9 WHERE id=$1`, id);
    const token = await fn.webhookClaim(prisma, id);
    expect(await fn.webhookFail(prisma, id, token!, 'still failing')).toBe('DEAD');
    expect(await val(prisma, `SELECT count(*)::int FROM payment_exceptions WHERE type='WEBHOOK_DEAD' AND webhook_event_id=$1`, id)).toBe(1);

    const ign = await event();
    const t2 = await fn.webhookClaim(prisma, ign);
    await fn.webhookComplete(prisma, ign, t2!, 'IGNORED');
    expect(await val(prisma, `SELECT status::text FROM webhook_events WHERE id=$1`, ign)).toBe('IGNORED');
  });
});

describe('outbox deliveries', () => {
  it('emit → claim (one row per consumer) → fenced publish → consume once', async () => {
    const agg = 'o' + uniq();
    const eventId = await tx(prisma, (t) => fn.emit(t, { aggregateType: 'order', aggregateId: agg, type: 'order.placed', payload: { n: 1 }, consumers: ['email.customer', 'notify.admin'] }));
    expect(Number.isSafeInteger(eventId)).toBe(true);
    const claimed = (await fn.outboxClaim(prisma, { limit: 1000, leaseSeconds: 30, redeliverSeconds: 1800, maxGenerations: 10 })).filter((c) => c.eventId === eventId);
    expect(claimed.map((c) => c.consumer).sort()).toEqual(['email.customer', 'notify.admin']);
    expect(claimed[0]).toMatchObject({ generation: 1, eventType: 'order.placed', payload: { n: 1 } });
    const [d1, d2] = claimed as [fn.OutboxClaim, fn.OutboxClaim];

    expect(await fn.outboxMarkPublished(prisma, d1.deliveryId, d1.leaseToken)).toBe(true);
    expect(await fn.outboxMarkPublished(prisma, d1.deliveryId, d1.leaseToken)).toBe(false);          // already published
    expect(await fn.outboxMarkPublished(prisma, d2.deliveryId, d1.leaseToken)).toBe(false);          // wrong token
    expect(await fn.outboxPublishFailed(prisma, d2.deliveryId, d2.leaseToken, 'redis down')).toBe(true);
    expect(await val(prisma, `SELECT status::text FROM outbox_deliveries WHERE id=$1`, d2.deliveryId)).toBe('PENDING');

    expect(await tx(prisma, async (t) => { const go = await fn.outboxBeginConsume(t, d1.deliveryId); if (go) await fn.outboxComplete(t, d1.deliveryId); return go; })).toBe(true);
    expect(await fn.outboxBeginConsume(prisma, d1.deliveryId)).toBe(false);
    expect(await fn.outboxComplete(prisma, d1.deliveryId)).toBe(false);
  });

  it('deliveries past the generation limit become DEAD with one OUTBOX_DEAD exception', async () => {
    const eventId = await fn.emit(prisma, { aggregateType: 'x', aggregateId: uniq(), type: 'x.y', payload: {}, consumers: ['email.customer'] });
    const delivery = await val<bigint>(prisma, `SELECT id FROM outbox_deliveries WHERE event_id=$1`, eventId);
    await prisma.$executeRawUnsafe(`UPDATE outbox_deliveries SET generation=10 WHERE id=$1`, delivery);
    const claimed = await fn.outboxClaim(prisma, { limit: 1000, leaseSeconds: 30, redeliverSeconds: 1800, maxGenerations: 10 });
    expect(claimed.some((c) => c.eventId === eventId)).toBe(false);
    expect(await val(prisma, `SELECT status::text FROM outbox_deliveries WHERE id=$1`, delivery)).toBe('DEAD');
    expect(await val(prisma, `SELECT count(*)::int FROM payment_exceptions WHERE dedupe_key=$1`, `OUTBOX_DEAD:${delivery}`)).toBe(1);
  });

  it('raiseException is deduplicated by key and emits one admin notification', async () => {
    const k = 'TEST:' + uniq();
    expect(await fn.raiseException(prisma, { type: 'RECON_MISMATCH', dedupeKey: k, details: { a: 1 } })).toBe(true);
    expect(await fn.raiseException(prisma, { type: 'RECON_MISMATCH', dedupeKey: k })).toBe(false);
    const ex = await val<number>(prisma, `SELECT id FROM payment_exceptions WHERE dedupe_key=$1`, k);
    expect(await val(prisma, `SELECT count(*)::int FROM outbox_events WHERE aggregate_type='payment_exception' AND aggregate_id=$1`, String(ex))).toBe(1);
  });

  it('history records a status transition', async () => {
    const cat = await catalog(prisma, [[{}]]);
    const O = await tx(prisma, (t) => order(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }], reserve: false }));
    await fn.history(prisma, { orderId: O.orderId, dimension: 'FULFILMENT', from: null, to: 'PACKED', actor: 'ADMIN', note: 'packed' });
    expect(await one(prisma, `SELECT dimension::text, from_value, to_value, actor_type::text, note FROM order_status_history WHERE order_id=$1`, O.orderId))
      .toEqual({ dimension: 'FULFILMENT', from_value: null, to_value: 'PACKED', actor_type: 'ADMIN', note: 'packed' });
  });
});

describe('sessions and authorization versions', () => {
  async function userWithSessions(role: fn.UserRole = 'ADMIN') {
    const user = await val<number>(prisma, `INSERT INTO users (email, role, status, updated_at) VALUES ($1,$2::"UserRole",'ACTIVE',now()) RETURNING id`, `u${uniq()}@x.in`, role);
    const session = (aud: 'STOREFRONT' | 'ADMIN') => val<string>(prisma, `INSERT INTO sessions (user_id, audience, auth_version, idle_expires_at, absolute_expires_at)
      VALUES ($1,$2::"SessionAudience",1,now() + interval '1 hour',now() + interval '1 day') RETURNING id::text`, user, aud);
    return { user, store: await session('STOREFRONT'), admin: await session('ADMIN') };
  }

  it('role change revokes admin sessions only; revoke-all ends every session; block marks the user BLOCKED', async () => {
    const s = await userWithSessions();
    expect(await fn.sessionValid(prisma, s.store)).toBe(true);
    expect(await fn.sessionValid(prisma, s.admin)).toBe(true);
    await fn.changeRole(prisma, s.user, 'STAFF');
    expect(await fn.sessionValid(prisma, s.admin)).toBe(false);
    expect(await fn.sessionValid(prisma, s.store)).toBe(true);
    await fn.revokeAllSessions(prisma, s.user, 'PASSWORD_CHANGED', true);
    expect(await fn.sessionValid(prisma, s.store)).toBe(false);
    expect(await val(prisma, `SELECT status::text FROM users WHERE id=$1`, s.user)).toBe('BLOCKED');
  });

  it('customers cannot hold admin sessions; unknown and expired sessions are invalid', async () => {
    const c = await userWithSessions('CUSTOMER');
    expect(await fn.sessionValid(prisma, c.store)).toBe(true);
    expect(await fn.sessionValid(prisma, c.admin)).toBe(false);
    expect(await fn.sessionValid(prisma, '00000000-0000-0000-0000-000000000000')).toBe(false);
    await prisma.$executeRawUnsafe(`UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE id=$1::uuid`, c.store);
    expect(await fn.sessionValid(prisma, c.store)).toBe(false);
  });

  it('rejects an invalid role value', async () => {
    const s = await userWithSessions();
    await expect(fn.changeRole(prisma, s.user, 'ROOT' as fn.UserRole)).rejects.toThrow(/invalid input value for enum/);
  });
});
