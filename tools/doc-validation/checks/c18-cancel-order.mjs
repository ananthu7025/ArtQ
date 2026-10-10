// Task 5.3: aq_cancel_order (database.md §8.3a, migration 0009). Concurrent cancels change the order once and create
// one refund; cancel racing dispatch: exactly one wins, never both; stock, sold counts and the coupon come back once;
// only what is still refundable is refunded; COD becomes NOT_COLLECTED; customers cannot cancel a packed order.
import { pool, tx, catalog, order, attempt, apply, val, one, eq, rejects } from '../lib/db.mjs';

const cancel = (c, id, by = 'ADMIN', notify = true) => c.query(`SELECT aq_cancel_order($1, $2, NULL, 'test', $3) AS r`, [id, by, notify]).then((r) => r.rows[0].r);
const invoice = (total) => {
  const tax = Math.round(total * 18 / 118), cgst = Math.floor(tax / 2);
  return { fy: '26-27', seller: {}, buyer: {}, place_of_supply: '32', lines: [{ kind: 'ITEM', taxable: total - tax, cgst, sgst: tax - cgst, igst: 0 }],
    taxable_total: total - tax, cgst_total: cgst, sgst_total: tax - cgst, igst_total: 0, rounding_adjustment: 0, grand_total: total };
};

export default {
  id: 'C18', title: 'Cancel: once under concurrency (one refund); cancel vs dispatch never both; stock/sold/coupon restored once; COD not collected',
  async run({ cfg }) {
    const db = pool(cfg, 60);
    try {
      const cat = await catalog(db, [[{ price: 1000, onHand: 100 }], [{ price: 3000, onHand: 100 }]]);
      const [v1, v2] = cat.products.map((p) => p.variantIds[0]);
      const [p1] = cat.products.map((p) => p.productId);
      const coupon = await val(db, `INSERT INTO coupons (code, title, type, value, updated_at) VALUES ('C18OFF','x','FLAT',500,now()) RETURNING id`);
      const stock = (v) => one(db, `SELECT on_hand, reserved FROM product_variants WHERE id = $1`, [v]);
      /** Prepaid: 2 × ₹10 + 1 × ₹30, shipping ₹5, coupon ₹5 → paid ₹50 through the real payment path (coupon REDEEMED). */
      const paid = async () => {
        const o = await tx(db, (c) => order(c, { lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }], shippingFee: 500, couponDiscount: 500 }));
        await tx(db, (c) => c.query(`SELECT aq_reserve_coupon($1,$2,NULL,$3,NULL,500)`, [o.orderId, coupon, `b${o.orderId}@x.in`]));
        const a = await tx(db, (c) => attempt(c, o.orderId, o.total));
        eq(await tx(db, (c) => apply(c, { providerOrderId: a.providerOrderId, paymentId: `pay_${o.orderId}`, amount: o.total })), 'APPLIED', 'paid');
        return o;
      };

      // Six cancels at once: one wins, one refund of the whole payment, stock/sold/coupon restored once.
      const s1 = await stock(v1);
      const sold = await val(db, `SELECT sold_count FROM products WHERE id = $1`, [p1]);
      const redeemed = await val(db, `SELECT redeemed_count FROM coupons WHERE id = $1`, [coupon]);
      const o = await paid();
      const race = await Promise.allSettled(Array.from({ length: 6 }, () => tx(db, (c) => cancel(c, o.orderId))));
      eq([...new Set(race.filter((x) => x.status === 'rejected').map((x) => x.reason.message))].filter((m) => !/INVALID_TRANSITION/.test(m)), [], 'no unexpected errors');
      eq(race.filter((x) => x.status === 'fulfilled').length, 1, 'one cancel');
      eq(race.filter((x) => x.status === 'rejected').every((x) => /INVALID_TRANSITION/.test(x.reason.message)), true, 'others INVALID_TRANSITION');
      const rf = (await db.query(`SELECT kind, amount, items_amount, shipping_amount, status FROM refunds WHERE order_id = $1`, [o.orderId])).rows;
      eq(rf, [{ kind: 'CANCELLATION', amount: o.total, items_amount: o.total - 500, shipping_amount: 500, status: 'REQUESTED' }], 'one full refund');
      eq(await val(db, `SELECT count(*)::int FROM outbox_events WHERE event_type = 'refund.requested'`), 1, 'one provider refund job');
      eq(await stock(v1), s1, 'stock back as before the order');
      eq(await val(db, `SELECT sold_count FROM products WHERE id = $1`, [p1]), sold, 'sold count back');
      eq([await val(db, `SELECT redeemed_count FROM coupons WHERE id = $1`, [coupon]), await val(db, `SELECT status::text FROM coupon_redemptions WHERE order_id = $1`, [o.orderId])], [redeemed, 'REVERSED'], 'coupon use reversed once');
      eq(await val(db, `SELECT status::text || '/' || payment_status::text FROM orders WHERE id = $1`, [o.orderId]), 'CANCELLED/PAID', 'cancelled; refund pending');

      // An earlier partial refund is not refunded again.
      const part = await paid();
      const item = await one(db, `SELECT id, net_amount FROM order_items WHERE order_id = $1 ORDER BY id LIMIT 1`, [part.orderId]);
      const pay = await val(db, `SELECT id FROM payments WHERE order_id = $1`, [part.orderId]);
      await tx(db, (c) => c.query(`SELECT aq_request_refund($1,$2,'GOODWILL',$3::jsonb,0,0,0,'goodwill','gw-1',NULL)`,
        [part.orderId, pay, JSON.stringify([{ order_item_id: item.id, quantity: 1, amount: 300 }])]));
      await tx(db, (c) => cancel(c, part.orderId));
      eq(await val(db, `SELECT amount FROM refunds WHERE order_id = $1 AND kind = 'CANCELLATION'`, [part.orderId]), part.total - 300, 'cancellation refunds only the rest');
      eq(await val(db, `SELECT refund_reserved FROM payments WHERE id = $1`, [pay]), part.total, 'payment fully reserved, never over');

      // Customers: only before packing; staff: also when packed; nobody once shipped.
      const packed = await paid();
      await db.query(`UPDATE orders SET status = 'CONFIRMED', fulfilment_status = 'PACKED' WHERE id = $1`, [packed.orderId]);
      await rejects(tx(db, (c) => cancel(c, packed.orderId, 'CUSTOMER')), /INVALID_TRANSITION/, 'customer cannot cancel a packed order');
      await tx(db, (c) => cancel(c, packed.orderId, 'ADMIN'));

      // Cancel racing dispatch, 10 times: exactly one of them, never both; a cancelled order has no invoice.
      let shippedWins = 0, cancelWins = 0;
      for (let i = 0; i < 10; i++) {
        const x = await paid();
        await db.query(`UPDATE orders SET status = 'CONFIRMED', fulfilment_status = 'PACKED' WHERE id = $1`, [x.orderId]);
        const [d, c] = await Promise.allSettled([
          tx(db, (q) => q.query(`SELECT aq_dispatch_order($1,'DTDC',$2,NULL,NULL,$3::jsonb,false,NULL)`, [x.orderId, `C18-${i}`, JSON.stringify(invoice(x.total))])),
          tx(db, (q) => cancel(q, x.orderId)),
        ]);
        eq([d.status, c.status].filter((s) => s === 'fulfilled').length, 1, `race ${i}: exactly one wins`);
        const st = await one(db, `SELECT status::text, fulfilment_status::text AS f, (SELECT count(*)::int FROM invoices WHERE order_id = $1) AS inv,
                                         (SELECT count(*)::int FROM refunds WHERE order_id = $1) AS rf FROM orders WHERE id = $1`, [x.orderId]);
        if (d.status === 'fulfilled') { shippedWins++; eq([st.f, st.inv, st.rf], ['SHIPPED', 1, 0], 'shipped: invoice, no refund'); }
        else { cancelWins++; eq([st.status, st.inv, st.rf], ['CANCELLED', 0, 1], 'cancelled: refund, no invoice'); }
      }
      eq(await val(db, `SELECT count(*)::int FROM inventory_reservations WHERE status = 'ACTIVE'`), 0, 'every reservation consumed or released');

      // COD: not collected, no refund; quiet cancel sends no email.
      const cod = await tx(db, (c) => order(c, { lines: [{ variantId: v2, qty: 1 }], method: 'COD', codFee: 400, status: 'PLACED', paymentStatus: 'COD_PENDING' }));
      const r = await tx(db, (c) => cancel(c, cod.orderId, 'CUSTOMER', false));
      eq([r.refund_id, r.payment_status], [null, 'NOT_COLLECTED'], 'COD: nothing to refund');
      eq(await val(db, `SELECT count(*)::int FROM outbox_events WHERE event_type = 'order.cancelled' AND payload->>'order_id' = $1`, [String(cod.orderId)]), 0, 'quiet');
      eq(await val(db, `SELECT count(*)::int FROM order_status_history WHERE order_id = $1 AND to_value IN ('CANCELLED', 'NOT_COLLECTED')`, [cod.orderId]), 2, 'history for both dimensions');
      await rejects(tx(db, (c) => cancel(c, cod.orderId)), /INVALID_TRANSITION/, 'already cancelled');
      return `6 concurrent cancels → 1 (one ₹${o.total / 100} refund, one provider job; stock, sold count and coupon restored once); earlier goodwill ₹3 → cancellation refunds the rest only; customer refused on packed, staff allowed; cancel vs dispatch ×10 → exactly one each time (${shippedWins} shipped, ${cancelWins} cancelled); COD → NOT_COLLECTED, no refund`;
    } finally { await db.end(); }
  },
};
