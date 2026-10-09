// Task 5.6: RTO received, lost parcels and COD remittances (database.md §8.4a, migration 0012). RTO: inspection must
// account for every unit, sellable units restocked once, order cancelled once (concurrently), prepaid items refunded
// without shipping (D-9), COD not collected, coupon reversed once. Lost: refund → full refund incl. shipping, no stock
// change, LOST_WRITE_OFF recorded; reship → no refund. Remittance: lines must add up, an order is remitted once even
// under concurrency, a duplicate reference is refused, a differing amount raises COD_REMITTANCE_MISMATCH.
import { pool, tx, catalog, order, attempt, apply, val, one, eq, rejects } from '../lib/db.mjs';

const invoice = (total) => {
  const tax = Math.round(total * 18 / 118), cgst = Math.floor(tax / 2);
  return { fy: '26-27', seller: {}, buyer: {}, place_of_supply: '32', lines: [{ kind: 'ITEM', taxable: total - tax, cgst, sgst: tax - cgst, igst: 0 }],
    taxable_total: total - tax, cgst_total: cgst, sgst_total: tax - cgst, igst_total: 0, rounding_adjustment: 0, grand_total: total };
};

export default {
  id: 'C21', title: 'RTO received once (restock, cancel, D-9 refund); lost → refund or reship; COD remittance once per order, totals and mismatches',
  async run({ cfg }) {
    const db = pool(cfg, 60);
    try {
      const cat = await catalog(db, [[{ price: 1000, onHand: 100 }], [{ price: 3000, onHand: 100 }]]);
      const [v1, v2] = cat.products.map((p) => p.variantIds[0]);
      const [p1] = cat.products.map((p) => p.productId);
      const coupon = await val(db, `INSERT INTO coupons (code, title, type, value, updated_at) VALUES ('C21OFF','x','FLAT',500,now()) RETURNING id`);
      const onHand = (v) => val(db, `SELECT on_hand FROM product_variants WHERE id = $1`, [v]);
      let awb = 0;
      /** Shipped: 2 × ₹10 + 1 × ₹30, shipping ₹5, coupon ₹5; prepaid through the payment path, or COD. */
      const shipped = async (method = 'RAZORPAY') => {
        const o = await tx(db, (c) => order(c, { lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }], shippingFee: 500, couponDiscount: 500, method, codFee: method === 'COD' ? 400 : 0 }));
        await tx(db, (c) => c.query(`SELECT aq_reserve_coupon($1,$2,NULL,$3,NULL,500)`, [o.orderId, coupon, `b${o.orderId}@x.in`]));
        if (method === 'COD') {
          await db.query(`UPDATE orders SET payment_status = 'UNPAID' WHERE id = $1`, [o.orderId]);           // the COD placement starts from an unpaid pending order
          await tx(db, (c) => c.query(`SELECT aq_place_cod_order($1, 'CUSTOMER')`, [o.orderId]));
        }
        else {
          const a = await tx(db, (c) => attempt(c, o.orderId, o.total));
          eq(await tx(db, (c) => apply(c, { providerOrderId: a.providerOrderId, paymentId: `pay_${o.orderId}`, amount: o.total })), 'APPLIED', 'paid');
        }
        await db.query(`UPDATE orders SET status = 'CONFIRMED', fulfilment_status = 'PACKED' WHERE id = $1`, [o.orderId]);
        await tx(db, (c) => c.query(`SELECT aq_dispatch_order($1,'DTDC',$2,NULL,NULL,$3::jsonb,false,NULL)`, [o.orderId, `C21-${++awb}`, JSON.stringify(invoice(o.total))]));
        const items = (await db.query(`SELECT id FROM order_items WHERE order_id = $1 ORDER BY id`, [o.orderId])).rows.map((r) => r.id);
        return { ...o, i1: items[0], i2: items[1] };
      };
      const rtoTransit = (o) => db.query(`UPDATE orders SET fulfilment_status = 'RTO_IN_TRANSIT' WHERE id = $1`, [o.orderId]);
      const inspection = (o, s1 = 2, d1 = 0, s2 = 1, d2 = 0) => JSON.stringify([{ order_item_id: o.i1, sellable_qty: s1, damaged_qty: d1 }, { order_item_id: o.i2, sellable_qty: s2, damaged_qty: d2 }]);
      const receive = (c, o, items) => c.query(`SELECT aq_receive_rto($1, $2::jsonb, true, NULL) AS r`, [o.orderId, items]).then((r) => r.rows[0].r);

      // RTO, prepaid: inspection must cover every unit; 5 concurrent receipts → one; items refunded, shipping kept.
      const o = await shipped();
      await rejects(tx(db, (c) => receive(c, o, inspection(o))), /INVALID_TRANSITION/, 'not returning yet');
      await rtoTransit(o);
      await rejects(tx(db, (c) => receive(c, o, inspection(o, 1, 0))), /RTO_INSPECTION_INVALID/, 'a unit unaccounted for');
      await rejects(tx(db, (c) => receive(c, o, JSON.stringify([{ order_item_id: o.i1, sellable_qty: 2, damaged_qty: 0 }]))), /RTO_INSPECTION_INVALID/, 'a line missing');
      const [h1, h2] = [await onHand(v1), await onHand(v2)];
      const sold = await val(db, `SELECT sold_count FROM products WHERE id = $1`, [p1]);
      const redeemed = await val(db, `SELECT redeemed_count FROM coupons WHERE id = $1`, [coupon]);
      const race = await Promise.allSettled(Array.from({ length: 5 }, () => tx(db, (c) => receive(c, o, inspection(o, 1, 1, 1, 0)))));
      eq(race.filter((x) => x.status === 'fulfilled').length, 1, 'one receipt');
      eq(race.filter((x) => x.status === 'rejected').every((x) => /INVALID_TRANSITION/.test(x.reason.message)), true, 'others refused');
      eq([await onHand(v1), await onHand(v2)], [h1 + 1, h2 + 1], 'sellable units restocked once (1 damaged not)');
      eq(await val(db, `SELECT count(*)::int FROM inventory_movements WHERE order_id = $1 AND reason = 'RTO_RESTOCK'`, [o.orderId]), 2, 'one movement per variant');
      eq(await one(db, `SELECT status::text, fulfilment_status::text AS f, payment_status::text AS p FROM orders WHERE id = $1`, [o.orderId]), { status: 'CANCELLED', f: 'RTO_RECEIVED', p: 'PAID' }, 'cancelled; refund pending');
      eq(await one(db, `SELECT kind::text, amount, shipping_amount FROM refunds WHERE order_id = $1`, [o.orderId]), { kind: 'CANCELLATION', amount: o.total - 500, shipping_amount: 0 }, 'items refunded, shipping kept (D-9)');
      eq(await val(db, `SELECT sold_count FROM products WHERE id = $1`, [p1]), sold - 2, 'sold count down once');
      eq(await val(db, `SELECT redeemed_count FROM coupons WHERE id = $1`, [coupon]), redeemed - 1, 'coupon use reversed once');

      // RTO, COD: not collected, no refund.
      const c1 = await shipped('COD');
      await rtoTransit(c1);
      eq(await tx(db, (c) => receive(c, c1, inspection(c1))), { refund_id: null }, 'COD: nothing to refund');
      eq(await val(db, `SELECT payment_status::text FROM orders WHERE id = $1`, [c1.orderId]), 'NOT_COLLECTED', 'COD not collected');

      // Lost: refund → full refund incl. shipping, no stock change; reship → order kept, no refund; twice → refused.
      const l = await shipped();
      const [g1, g2] = [await onHand(v1), await onHand(v2)];
      const lost = (c, x, how) => c.query(`SELECT aq_mark_lost($1, $2, 'Courier claim 77', true, NULL) AS r`, [x.orderId, how]).then((r) => r.rows[0].r);
      const lr = await Promise.allSettled(Array.from({ length: 4 }, () => tx(db, (c) => lost(c, l, 'REFUND'))));
      eq(lr.filter((x) => x.status === 'fulfilled').length, 1, 'lost once');
      eq(await one(db, `SELECT amount, shipping_amount FROM refunds WHERE order_id = $1`, [l.orderId]), { amount: l.total, shipping_amount: 500 }, 'full refund');
      eq([await onHand(v1), await onHand(v2)], [g1, g2], 'no stock change');
      eq(await val(db, `SELECT count(*)::int FROM inventory_movements WHERE order_id = $1 AND reason = 'LOST_WRITE_OFF' AND on_hand_delta = 0`, [l.orderId]), 2, 'write-off recorded');
      eq(await val(db, `SELECT status::text || '/' || fulfilment_status::text FROM orders WHERE id = $1`, [l.orderId]), 'CANCELLED/LOST', 'cancelled, lost');
      const rs = await shipped('COD');
      eq(await tx(db, (c) => lost(c, rs, 'RESHIP')), { refund_id: null }, 'reship: no refund');
      eq(await val(db, `SELECT status::text || '/' || fulfilment_status::text || '/' || payment_status::text FROM orders WHERE id = $1`, [rs.orderId]), 'CONFIRMED/LOST/NOT_COLLECTED', 'kept for the replacement');
      await rejects(tx(db, (c) => lost(c, rs, 'REFUND')), /INVALID_TRANSITION/, 'already lost');

      // COD remittance: delivered COD orders; lines add up; once per order (concurrent remittances); mismatch flagged.
      const delivered = async () => { const x = await shipped('COD'); await db.query(`UPDATE orders SET fulfilment_status = 'DELIVERED', payment_status = 'COD_COLLECTED' WHERE id = $1`, [x.orderId]); return x; };
      const [d1, d2, d3] = [await delivered(), await delivered(), await delivered()];
      const remit = (c, ref, items, amount = items.reduce((s, i) => s + i.amount, 0)) =>
        c.query(`SELECT aq_record_cod_remittance('DTDC', $1, now(), $2, NULL, $3::jsonb, NULL) AS r`, [ref, amount, JSON.stringify(items)]).then((r) => r.rows[0].r);
      await rejects(tx(db, (c) => remit(c, 'R0', [{ order_id: d1.orderId, amount: d1.total }], d1.total + 1)), /COD_REMITTANCE_INVALID:total/, 'lines must add up');
      await rejects(tx(db, (c) => remit(c, 'R0', [{ order_id: c1.orderId, amount: 100 }])), /COD_REMITTANCE_INVALID:order/, 'not delivered / not collected');
      await rejects(tx(db, (c) => remit(c, 'R0', [{ order_id: d1.orderId, amount: 100 }, { order_id: d1.orderId, amount: 100 }])), /COD_REMITTANCE_INVALID:orders/, 'an order twice');
      const rr = await Promise.allSettled(Array.from({ length: 5 }, (_, n) => tx(db, (c) => remit(c, `R${n + 1}`, [{ order_id: d1.orderId, amount: d1.total }, { order_id: d2.orderId, amount: d2.total }]))));
      eq(rr.filter((x) => x.status === 'fulfilled').length, 1, 'each order remitted once');
      eq(rr.filter((x) => x.status === 'rejected').every((x) => /COD_REMITTANCE_INVALID|duplicate key/.test(x.reason.message)), true, 'the others refused');
      eq(await val(db, `SELECT count(*)::int FROM cod_remittances`), 1, 'refusals leave nothing');
      eq(await val(db, `SELECT string_agg(payment_status::text, ',' ORDER BY id) FROM orders WHERE id IN ($1, $2)`, [d1.orderId, d2.orderId]), 'COD_REMITTED,COD_REMITTED', 'remitted');
      const used = await val(db, `SELECT reference FROM cod_remittances`);
      await rejects(tx(db, (c) => remit(c, used, [{ order_id: d3.orderId, amount: d3.total }])), /COD_REMITTANCE_INVALID:reference/, 'same reference refused');
      const m = await tx(db, (c) => remit(c, 'R9', [{ order_id: d3.orderId, amount: d3.total - 4000 }]));
      eq(m.mismatches, [{ expected: d3.total, order_id: d3.orderId, remitted: d3.total - 4000 }], 'mismatch reported');
      eq(await one(db, `SELECT type::text, amount FROM payment_exceptions WHERE order_id = $1`, [d3.orderId]), { type: 'COD_REMITTANCE_MISMATCH', amount: -4000 }, 'exception raised');
      return `RTO ×5 concurrent → 1 (1+1 restocked, 1 damaged kept out; items refunded ₹${(o.total - 500) / 100}, shipping kept; sold count and coupon once); COD RTO → not collected; lost ×4 → 1 (full refund incl. shipping, no stock change, write-off recorded); reship keeps the order; remittance: totals checked, ×5 concurrent → 1, duplicate reference refused, ₹40 short → mismatch exception`;
    } finally { await db.end(); }
  },
};
