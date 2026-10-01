// Finding 1: excess capture after PARTIALLY_REFUNDED / REFUNDED; late capture after expiry (with and without stock)
// and after cancellation follow the documented policy.
import { pool, tx, catalog, order, attempt, apply, val, one, eq } from '../lib/db.mjs';

export default {
  id: 'C04', title: 'Excess capture after partial/full refund; late capture after expiry/cancellation',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      const cat = await catalog(db, [[{ price: 40000, onHand: 4 }]]);
      const v = cat.products[0].variantIds[0];
      // A: paid, partially refunded, then a distinct second capture
      const A = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 2 }] }));
      const a1 = await attempt(db, A.orderId, A.total, 'CLOSED');
      eq(await tx(db, (c) => apply(c, { providerOrderId: a1.providerOrderId, paymentId: 'pay_A1', amount: A.total })), 'APPLIED', 'A first');
      const p1 = await val(db, `SELECT id FROM payments WHERE provider_payment_id = 'pay_A1'`);
      const rf = await tx(db, (c) => val(c, `SELECT aq_request_refund($1,$2,'GOODWILL',$3::jsonb,0,0,0,'x','k-a',NULL)`,
        [A.orderId, p1, JSON.stringify([{ order_item_id: A.items[0].orderItemId, quantity: 0, amount: 10000 }])]));
      await tx(db, (c) => c.query(`SELECT aq_mark_refund_processed($1,'rfnd_1')`, [rf]));
      eq(await val(db, `SELECT payment_status FROM orders WHERE id=$1`, [A.orderId]), 'PARTIALLY_REFUNDED', 'A partial');
      const a2 = await attempt(db, A.orderId, A.total, 'CLOSED');
      const second = await tx(db, (c) => apply(c, { providerOrderId: a2.providerOrderId, paymentId: 'pay_A2', amount: A.total }));
      eq(second, 'EXCESS', 'second capture after partial refund');
      // full refund of the rest, then a third capture
      const rf2 = await tx(db, (c) => val(c, `SELECT aq_request_refund($1,$2,'GOODWILL',$3::jsonb,0,0,0,'x','k-b',NULL)`,
        [A.orderId, p1, JSON.stringify([{ order_item_id: A.items[0].orderItemId, quantity: 2, amount: 70000 }])]));
      await tx(db, (c) => c.query(`SELECT aq_mark_refund_processed($1,'rfnd_2')`, [rf2]));
      eq(await val(db, `SELECT payment_status FROM orders WHERE id=$1`, [A.orderId]), 'REFUNDED', 'A refunded');
      const a3 = await attempt(db, A.orderId, A.total, 'CLOSED');
      eq(await tx(db, (c) => apply(c, { providerOrderId: a3.providerOrderId, paymentId: 'pay_A3', amount: A.total })), 'EXCESS', 'third after full refund');
      const ex = await one(db, `SELECT captured_amount,
          (SELECT count(*) FROM refunds WHERE order_id=$1 AND kind='EXCESS_CAPTURE' AND unallocated_amount=$2) AS excess_refunds,
          (SELECT count(*) FROM payment_exceptions WHERE order_id=$1 AND type='EXCESS_CAPTURE') AS exc,
          (SELECT count(*) FROM outbox_events WHERE event_type='order.placed') AS placed
        FROM orders WHERE id=$1`, [A.orderId, A.total]);
      eq(ex.captured_amount, A.total, 'captured_amount unchanged by excess'); eq(Number(ex.excess_refunds), 2, 'auto refunds'); eq(Number(ex.exc), 2, 'exceptions');
      eq(Number(ex.placed), 1, 'order.placed emitted once');

      // B: expired, stock still available → restored
      const B = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }] }));
      const b1 = await attempt(db, B.orderId, B.total);
      await tx(db, (c) => c.query(`SELECT aq_release_unpaid_order($1,'EXPIRED','timeout','SYSTEM')`, [B.orderId]));
      eq(await tx(db, (c) => apply(c, { providerOrderId: b1.providerOrderId, paymentId: 'pay_B1', amount: B.total })), 'APPLIED', 'late with stock');
      const b = await one(db, `SELECT status, (SELECT count(*) FROM inventory_reservations WHERE order_id=$1 AND status='ACTIVE') AS act FROM orders WHERE id=$1`, [B.orderId]);
      eq(b, { status: 'PLACED', act: '1' }, 'B restored with new reservation');

      // C: expired, stock gone → LATE + refund
      const C = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }] }));
      const c1 = await attempt(db, C.orderId, C.total);
      await tx(db, (c) => c.query(`SELECT aq_release_unpaid_order($1,'EXPIRED','timeout','SYSTEM')`, [C.orderId]));
      await tx(db, (c) => c.query(`SELECT aq_adjust_on_hand($1::jsonb, NULL)`, [JSON.stringify([{ variant_id: v, kind: 'RECOUNT', quantity: 3 }])]));
      eq(await tx(db, (c) => apply(c, { providerOrderId: c1.providerOrderId, paymentId: 'pay_C1', amount: C.total })), 'LATE', 'late without stock');
      eq(await val(db, `SELECT status FROM orders WHERE id=$1`, [C.orderId]), 'EXPIRED', 'C stays expired');

      // D: cancelled → never revived
      const D = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }], reserve: false }));
      const d1 = await attempt(db, D.orderId, D.total);
      await tx(db, (c) => c.query(`SELECT aq_release_unpaid_order($1,'CANCELLED','customer','CUSTOMER')`, [D.orderId]));
      eq(await tx(db, (c) => apply(c, { providerOrderId: d1.providerOrderId, paymentId: 'pay_D1', amount: D.total })), 'LATE', 'cancelled');
      const late = await val(db, `SELECT count(*) FROM refunds WHERE kind='LATE_CAPTURE'`);
      eq(Number(late), 2, 'late-capture refunds');
      // E: amount mismatch → HELD, not paid
      const E = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }], reserve: false }));
      const e1 = await attempt(db, E.orderId, E.total);
      eq(await tx(db, (c) => apply(c, { providerOrderId: e1.providerOrderId, paymentId: 'pay_E1', amount: E.total - 100 })), 'HELD', 'mismatch');
      eq(await val(db, `SELECT payment_status FROM orders WHERE id=$1`, [E.orderId]), 'UNPAID', 'E not paid');
      return 'after PARTIALLY_REFUNDED → EXCESS; after REFUNDED → EXCESS (auto refunds, order.placed once); expired+stock → APPLIED with new reservation; expired+no stock → LATE + refund; cancelled → LATE + refund; amount mismatch → HELD';
    } finally { await db.end(); }
  },
};
