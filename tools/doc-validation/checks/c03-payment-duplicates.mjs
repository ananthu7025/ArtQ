// Finding 1: the same captured payment arriving via verify, webhook and reconciliation (concurrently and
// repeatedly) applies exactly once; every business side effect happens once.
import { pool, tx, catalog, order, attempt, apply, val, eq, assert } from '../lib/db.mjs';

export default {
  id: 'C03', title: 'Duplicate captured payment via verify + webhook + reconciliation → side effects once',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      const cat = await catalog(db, [[{ price: 50000, onHand: 5 }, { price: 9000, onHand: 5 }]]);
      const [v1, v2] = cat.products[0].variantIds;
      const cart = await val(db, `INSERT INTO carts (token_hash, updated_at) VALUES (md5(random()::text)||md5(random()::text), now()) RETURNING id`);
      const coupon = await val(db, `INSERT INTO coupons (code, title, type, value, usage_limit_total, updated_at) VALUES ('C03','x','FLAT',5000,10,now()) RETURNING id`);
      const o = await tx(db, async (c) => {
        const o = await order(c, { lines: [{ variantId: v1, qty: 1 }, { variantId: v2, qty: 2 }], couponDiscount: 5000, cartId: cart });
        await c.query(`SELECT aq_reserve_coupon($1,$2,NULL,'buyer@example.com',NULL,5000)`, [o.orderId, coupon]);
        return o;
      });
      const a = await attempt(db, o.orderId, o.total);
      const pay = { providerOrderId: a.providerOrderId, paymentId: 'pay_C03', amount: o.total };
      // concurrent: browser verify, webhook, reconciler (+2 late duplicates incl. an older AUTHORIZED event)
      const outcomes = await Promise.all(['CUSTOMER', 'WEBHOOK', 'SYSTEM'].map((actor) => tx(db, (c) => apply(c, { ...pay, actor }))));
      outcomes.push(await tx(db, (c) => apply(c, { ...pay, actor: 'WEBHOOK' })));
      outcomes.push(await tx(db, (c) => apply(c, { ...pay, status: 'AUTHORIZED', actor: 'WEBHOOK' })));
      const applied = outcomes.filter((x) => x === 'APPLIED').length;
      eq(applied, 1, 'exactly one APPLIED');
      eq(outcomes.filter((x) => x === 'DUPLICATE').length, 4, 'others DUPLICATE');
      const st = await db.query(`SELECT
        (SELECT row(status, payment_status, captured_amount)::text FROM orders WHERE id = $1) AS ord,
        (SELECT row(reserved_count, redeemed_count)::text FROM coupons WHERE id = $2) AS cpn,
        (SELECT status FROM coupon_redemptions WHERE order_id = $1) AS red,
        (SELECT sold_count FROM products WHERE id = $3) AS sold,
        (SELECT status FROM carts WHERE id = $4) AS cart,
        (SELECT count(*) FROM order_status_history WHERE order_id = $1 AND to_value = 'PAID') AS hist,
        (SELECT count(*) FROM outbox_events WHERE event_type = 'order.placed' AND payload->>'order_id' = $1::text) AS evts,
        (SELECT count(*) FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE e.event_type = 'order.placed') AS dels,
        (SELECT row(status, status_rank, allocation)::text FROM payments WHERE provider_payment_id = 'pay_C03') AS pay`,
        [o.orderId, coupon, cat.products[0].productId, cart]);
      const r = st.rows[0];
      eq(r.ord, `(PLACED,PAID,${o.total})`, 'order'); eq(r.cpn, '(0,1)', 'coupon counters'); eq(r.red, 'REDEEMED', 'redemption');
      eq(r.sold, 3, 'sold_count'); eq(r.cart, 'CONVERTED', 'cart'); eq(Number(r.hist), 1, 'history'); eq(Number(r.evts), 1, 'outbox events');
      eq(Number(r.dels), 3, 'deliveries (3 consumers)'); eq(r.pay, '(CAPTURED,3,APPLIED)', 'payment row not downgraded');
      return `outcomes ${JSON.stringify(outcomes)}; order ${r.ord}; coupon ${r.cpn}; sold ${r.sold}; 1 history row, 1 event, 3 deliveries`;
    } finally { await db.end(); }
  },
};
