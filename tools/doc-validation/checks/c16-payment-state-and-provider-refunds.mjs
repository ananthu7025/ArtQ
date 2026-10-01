// Review 4: (1) AUTHORIZED → fully REFUNDED must not leave the order PROCESSING (expiry releases once);
// (2) provider refunds made after allocation block new refunds/retries until reconciled into the ledger,
//     without counting ArtQ's own refunds twice.
import { pool, tx, catalog, order, attempt, apply, val, one, eq, rejects } from '../lib/db.mjs';

const refunds = (q, p) => q.query(`SELECT aq_reconcile_provider_refunds($1,$2::jsonb) AS r`, [p.payment, JSON.stringify(p.list)]).then((x) => x.rows[0].r);

export default {
  id: 'C16', title: 'AUTHORIZED→REFUNDED releases on expiry once; later provider refunds gate refund capacity until reconciled',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      const cat = await catalog(db, [[{ price: 10000, onHand: 5 }]]);
      const v = cat.products[0].variantIds[0];

      // ── 1. AUTHORIZED → REFUNDED → expiry ──────────────────────────────
      const cp = await val(db, `INSERT INTO coupons (code,title,type,value,usage_limit_total,updated_at) VALUES ('C16','x','FLAT',100,5,now()) RETURNING id`);
      const O = await tx(db, async (c) => { const o = await order(c, { lines: [{ variantId: v, qty: 2 }], couponDiscount: 100 });
        await c.query(`SELECT aq_reserve_coupon($1,$2,NULL,'b@x.in',NULL,100)`, [o.orderId, cp]); return o; });
      const a = await attempt(db, O.orderId, O.total);
      const p1 = { providerOrderId: a.providerOrderId, paymentId: 'pay_auth', amount: O.total };
      eq(await tx(db, (c) => apply(c, { ...p1, status: 'AUTHORIZED' })), 'AUTHORIZED', 'authorized');
      eq(await val(db, `SELECT payment_status FROM orders WHERE id=$1`, [O.orderId]), 'PROCESSING', 'processing');
      eq(await tx(db, (c) => val(c, `SELECT aq_release_unpaid_order($1,'EXPIRED','t','SYSTEM')`, [O.orderId])), 'SKIPPED', 'live authorization not expired');
      // authorization auto-refunded by the provider (uncaptured authorization voided)
      eq(await tx(db, (c) => apply(c, { ...p1, status: 'REFUNDED', amountRefunded: O.total })), 'VOID', 'void');
      eq(await val(db, `SELECT payment_status FROM orders WHERE id=$1`, [O.orderId]), 'UNPAID', 'reassessed to UNPAID');
      const rel = await Promise.all([1, 2, 3].map(() => tx(db, (c) => val(c, `SELECT aq_release_unpaid_order($1,'EXPIRED','t','SYSTEM')`, [O.orderId]))));
      eq(rel.filter((x) => x === 'EXPIRED').length, 1, 'expired once'); eq(rel.filter((x) => x === 'SKIPPED').length, 2, 'others skipped');
      const st = await one(db, `SELECT o.status, v.reserved, c.reserved_count, c.redeemed_count,
          (SELECT status FROM coupon_redemptions WHERE order_id=o.id) AS red,
          (SELECT count(*) FROM inventory_movements WHERE order_id=o.id AND reason='RELEASE') AS releases,
          (SELECT count(*) FROM order_status_history WHERE order_id=o.id AND from_value='PROCESSING' AND to_value='UNPAID') AS back
        FROM orders o, product_variants v, coupons c WHERE o.id=$1 AND v.id=$2 AND c.id=$3`, [O.orderId, v, cp]);
      eq(st, { status: 'EXPIRED', reserved: 0, reserved_count: 0, redeemed_count: 0, red: 'RELEASED', releases: '1', back: '1' }, 'released exactly once');
      // a second live authorization keeps the order PROCESSING
      const O2 = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }] }));
      const b1 = await attempt(db, O2.orderId, O2.total, 'CLOSED'), b2 = await attempt(db, O2.orderId, O2.total);
      await tx(db, (c) => apply(c, { providerOrderId: b1.providerOrderId, paymentId: 'pay_b1', amount: O2.total, status: 'AUTHORIZED' }));
      await tx(db, (c) => apply(c, { providerOrderId: b2.providerOrderId, paymentId: 'pay_b2', amount: O2.total, status: 'AUTHORIZED' }));
      await tx(db, (c) => apply(c, { providerOrderId: b1.providerOrderId, paymentId: 'pay_b1', amount: O2.total, status: 'REFUNDED', amountRefunded: O2.total }));
      eq(await val(db, `SELECT payment_status FROM orders WHERE id=$1`, [O2.orderId]), 'PROCESSING', 'other authorization still live');

      // ── 2. HELD partial → provider refunds the rest → new refund blocked until reconciled ──
      const H = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }], reserve: false }));
      const ha = await attempt(db, H.orderId, 10000);
      const hp = { providerOrderId: ha.providerOrderId, paymentId: 'pay_held', amount: 10000 };
      eq(await tx(db, (c) => apply(c, { ...hp, amountRefunded: 3000 })), 'HELD', 'held, ₹30 recorded');
      eq(await tx(db, (c) => apply(c, { ...hp, status: 'REFUNDED', amountRefunded: 10000 })), 'DUPLICATE', 'later full refund observed');
      const hid = await val(db, `SELECT id FROM payments WHERE provider_payment_id='pay_held'`);
      eq(await one(db, `SELECT provider_amount_refunded, refund_reserved FROM payments WHERE id=$1`, [hid]), { provider_amount_refunded: 10000, refund_reserved: 3000 }, 'unexplained ₹70');
      const g = await rejects(tx(db, (c) => c.query(`SELECT aq_request_refund($1,$2,'EXCESS_CAPTURE','[]'::jsonb,0,0,7000,'x','k-h1',NULL)`, [H.orderId, hid])),
        /REFUND_RECONCILIATION_REQUIRED/, 'extra ₹70 refund rejected while unexplained');
      const hlist = [{ id: 'rfnd_h1', amount: 3000, status: 'processed' }, { id: 'rfnd_h2', amount: 7000, status: 'processed' }];
      eq(await refunds(db, { payment: hid, list: hlist }), 'RECONCILED', 'reconciled');
      eq(await refunds(db, { payment: hid, list: hlist }), 'RECONCILED', 'idempotent');
      eq(await one(db, `SELECT refund_reserved, amount_refunded, (SELECT count(*) FROM refunds WHERE payment_id=$1) AS n FROM payments WHERE id=$1`, [hid]),
        { refund_reserved: 10000, amount_refunded: 10000, n: '2' }, 'external ₹70 recorded once');
      await rejects(tx(db, (c) => c.query(`SELECT aq_request_refund($1,$2,'EXCESS_CAPTURE','[]'::jsonb,0,0,1,'x','k-h2',NULL)`, [H.orderId, hid])),
        /REFUND_EXCEEDS_CAPACITY:payment/, 'no capacity left after reconciliation');
      eq(await val(db, `SELECT count(*) FROM payment_exceptions WHERE payment_id=$1 AND type='RECON_MISMATCH' AND status='OPEN'`, [hid]), '0', 'mismatch resolved');

      // ── 3. APPLIED payment: own pending refund + external refund; no double count; retry gated ──
      const A = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }] }));
      const aa = await attempt(db, A.orderId, A.total);
      const ap = { providerOrderId: aa.providerOrderId, paymentId: 'pay_applied', amount: A.total };
      eq(await tx(db, (c) => apply(c, ap)), 'APPLIED', 'applied');
      const aid = await val(db, `SELECT id FROM payments WHERE provider_payment_id='pay_applied'`);
      const item = A.items[0].orderItemId;
      const req = (amt, key) => tx(db, (c) => val(c, `SELECT aq_request_refund($1,$2,'RETURN',$3::jsonb,0,0,0,'r',$4,NULL)`,
        [A.orderId, aid, JSON.stringify([{ order_item_id: item, quantity: 0, amount: amt }]), key]));
      const F = await req(1000, 'k-f');
      await tx(db, (c) => c.query(`SELECT aq_refund_attempt_result((SELECT id FROM refund_attempts WHERE refund_id=$1),'FAILED',400,'{}',NULL)`, [F]));
      const R = await req(4000, 'k-r');                                   // ours, pending at provider
      eq(await tx(db, (c) => apply(c, { ...ap, amountRefunded: 6000 })), 'DUPLICATE', 'provider shows 6000 (ours 4000 + external 2000)');
      await rejects(tx(db, (c) => c.query(`SELECT aq_retry_refund($1)`, [F])), /REFUND_RECONCILIATION_REQUIRED/, 'retry blocked while unexplained');
      await rejects(req(500, 'k-new'), /REFUND_RECONCILIATION_REQUIRED/, 'new refund blocked while unexplained');
      const alist = [{ id: 'rfnd_ours', amount: 4000, status: 'processed', notes: { aq_refund_id: String(R) } },
                     { id: 'rfnd_ext', amount: 2000, status: 'processed', notes: {} }];
      const rr = await Promise.all([1, 2, 3, 4].map(() => tx(db, (c) => refunds(c, { payment: aid, list: alist }))));
      eq(rr.every((x) => x === 'RECONCILED'), true, 'concurrent reconciles');
      const s3 = await one(db, `SELECT o.refunded_amount, o.refund_reserved_total, o.payment_status, p.refund_reserved, p.amount_refunded,
          (SELECT status FROM refunds WHERE id=$3) AS ours, (SELECT count(*) FROM refunds WHERE payment_id=p.id AND kind='PROVIDER_INITIATED') AS ext
        FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.id=$1 AND p.id=$2`, [A.orderId, aid, R]);
      eq(s3, { refunded_amount: 6000, refund_reserved_total: 6000, payment_status: 'PARTIALLY_REFUNDED', refund_reserved: 6000, amount_refunded: 6000,
               ours: 'PROCESSED', ext: '1' }, 'own refund processed once, external recorded once, totals consistent');
      eq(await tx(db, (c) => val(c, `SELECT aq_retry_refund($1)`, [F])), 2, 'retry allowed after reconciliation');
      return `AUTHORIZED→REFUNDED → VOID, order PROCESSING→UNPAID, 3 concurrent expiries → 1 EXPIRED (stock 0, coupon released, 1 RELEASE movement); ` +
             `second live authorization keeps PROCESSING; HELD ₹30 + later provider ₹70 → extra refund rejected (${g.slice(0, 38)}), reconcile records ₹70 once, then capacity exhausted; ` +
             `APPLIED with own ₹40 pending + external ₹20 → retry/new refunds blocked; 4 concurrent reconciles → own refund PROCESSED once, external once, order refunded ₹60; retry then allowed`;
    } finally { await db.end(); }
  },
};
