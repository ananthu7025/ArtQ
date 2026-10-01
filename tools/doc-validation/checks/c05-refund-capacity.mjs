// Finding 4: item-, component- and order-level refund capacity under concurrency (online and COD).
import { pool, tx, catalog, order, attempt, apply, val, one, eq } from '../lib/db.mjs';

const req = (c, o, pay, items, ship = 0, cod = 0, key = null) =>
  val(c, `SELECT aq_request_refund($1,$2,'RETURN',$3::jsonb,$4,$5,0,'t',$6,NULL)`, [o, pay, JSON.stringify(items), ship, cod, key]);

async function race(db, n, fn) {
  const r = await Promise.allSettled(Array.from({ length: n }, () => tx(db, fn)));
  return { ok: r.filter((x) => x.status === 'fulfilled').length, errors: [...new Set(r.filter((x) => x.status === 'rejected').map((x) => x.reason.message))] };
}

export default {
  id: 'C05', title: 'Concurrent refunds on one item, shipping and COD-fee components; COD manual refunds',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      const cat = await catalog(db, [[{ price: 50000, onHand: 10 }, { price: 50000, onHand: 10 }]]);
      const [v1, v2] = cat.products[0].variantIds;
      const O = await tx(db, (c) => order(c, { lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 2 }], shippingFee: 6000 }));
      const a = await attempt(db, O.orderId, O.total);
      await tx(db, (c) => apply(c, { providerOrderId: a.providerOrderId, paymentId: 'pay_C05', amount: O.total }));
      const pay = await val(db, `SELECT id FROM payments WHERE provider_payment_id='pay_C05'`);
      const item1 = O.items[0].orderItemId;   // net 100000, payment total 206000 ⇒ payment capacity is NOT the limit
      const r1 = await race(db, 8, (c) => req(c, O.orderId, pay, [{ order_item_id: item1, quantity: 1, amount: 60000 }]));
      eq(r1.ok, 1, 'only one 60000 refund fits item net 100000');
      const it = await one(db, `SELECT refund_reserved_amount, refund_reserved_qty FROM order_items WHERE id=$1`, [item1]);
      eq(it, { refund_reserved_amount: 60000, refund_reserved_qty: 1 }, 'item reservation');
      const r2 = await race(db, 6, (c) => req(c, O.orderId, pay, [], 6000));
      eq(r2.ok, 1, 'shipping refundable once');
      const tot = await one(db, `SELECT refund_reserved_total, refund_reserved_shipping, (SELECT refund_reserved FROM payments WHERE id=$2) AS p FROM orders WHERE id=$1`, [O.orderId, pay]);
      eq(tot, { refund_reserved_total: 66000, refund_reserved_shipping: 6000, p: 66000 }, 'order/payment reservations');

      // COD: manual refunds limited by order total and components, after collection only
      const C = await tx(db, (c) => order(c, { lines: [{ variantId: v1, qty: 1 }], method: 'COD', codFee: 4000 }));
      const early = await Promise.allSettled([tx(db, (c) => req(c, C.orderId, null, [{ order_item_id: C.items[0].orderItemId, quantity: 1, amount: 50000 }]))]);
      eq(early[0].status, 'rejected', 'COD refund before collection rejected');
      await db.query(`UPDATE orders SET payment_status='COD_COLLECTED' WHERE id=$1`, [C.orderId]);
      const r3 = await race(db, 5, (c) => req(c, C.orderId, null, [{ order_item_id: C.items[0].orderItemId, quantity: 1, amount: 50000 }], 0, 4000));
      eq(r3.ok, 1, 'one full COD manual refund');
      eq(await val(db, `SELECT count(*) FROM refund_attempts ra JOIN refunds r ON r.id=ra.refund_id WHERE r.order_id=$1`, [C.orderId]), '0', 'manual refunds make no provider attempt');
      // cancelling the manual refund releases capacity once; online refunds cannot be cancelled
      const manual = await val(db, `SELECT id FROM refunds WHERE order_id=$1 AND status='REQUESTED'`, [C.orderId]);
      await tx(db, (c) => c.query(`SELECT aq_cancel_manual_refund($1)`, [manual]));
      eq(await val(db, `SELECT refund_reserved_total FROM orders WHERE id=$1`, [C.orderId]), 0, 'released after cancel');
      const again = await Promise.allSettled([tx(db, (c) => c.query(`SELECT aq_cancel_manual_refund($1)`, [manual]))]);
      eq(again[0].status, 'rejected', 'second cancel rejected');
      const online = await val(db, `SELECT id FROM refunds WHERE order_id=$1 LIMIT 1`, [O.orderId]);
      const oc = await Promise.allSettled([tx(db, (c) => c.query(`SELECT aq_cancel_manual_refund($1)`, [online]))]);
      eq(oc[0].status, 'rejected', 'online refund not cancellable');
      return `item race 8×₹600 on ₹1,000 net → ${r1.ok} accepted (${r1.errors.join(', ')}); shipping race 6× → ${r2.ok}; COD race 5× → ${r3.ok}; reserved total ${tot.refund_reserved_total}`;
    } finally { await db.end(); }
  },
};
