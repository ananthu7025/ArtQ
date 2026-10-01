// Review 3, finding 1: a capture that arrives before payment_attempts.provider_order_id is saved is recorded
// UNLINKED and is later recovered exactly once; conflicting identities can never attach it elsewhere.
import { pool, tx, catalog, order, attempt, apply, val, one, eq } from '../lib/db.mjs';

export default {
  id: 'C14', title: 'UNLINKED payment recovery: capture before mapping, concurrent recovery once, conflicts rejected',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      const cat = await catalog(db, [[{ price: 30000, onHand: 10 }]]);
      const v = cat.products[0].variantIds[0];
      const cart = await val(db, `INSERT INTO carts (token_hash, updated_at) VALUES (md5('c14')||md5('c14x'), now()) RETURNING id`);
      const coupon = await val(db, `INSERT INTO coupons (code, title, type, value, usage_limit_total, updated_at) VALUES ('C14','x','FLAT',1000,5,now()) RETURNING id`);
      const O = await tx(db, async (c) => {
        const o = await order(c, { lines: [{ variantId: v, qty: 2 }], couponDiscount: 1000, cartId: cart });
        await c.query(`SELECT aq_reserve_coupon($1,$2,NULL,'buyer@example.com',NULL,1000)`, [o.orderId, coupon]);
        return o;
      });
      // attempt row exists but the provider order id is not saved yet (crash between Razorpay create and TX2)
      const attId = await val(db, `INSERT INTO payment_attempts (order_id, receipt, amount, status, updated_at) VALUES ($1,'AQA_C14',$2,'CREATING',now()) RETURNING id`, [O.orderId, O.total]);
      const p = { providerOrderId: 'order_C14', paymentId: 'pay_C14', amount: O.total };
      eq(await tx(db, (c) => apply(c, p)), 'UNLINKED', 'capture before mapping');
      eq(await tx(db, (c) => apply(c, p)), 'UNLINKED', 'still unlinked, no duplicate exception');
      const u = await one(db, `SELECT order_id, allocation, (SELECT row(status, payment_id IS NOT NULL)::text FROM payment_exceptions WHERE dedupe_key='UNLINKED_PAYMENT:pay_C14') AS exc FROM payments WHERE provider_payment_id='pay_C14'`);
      eq(u, { order_id: null, allocation: 'UNLINKED', exc: '(OPEN,t)' }, 'recorded UNLINKED with visible exception');
      eq(await val(db, `SELECT status FROM orders WHERE id=$1`, [O.orderId]), 'PENDING_PAYMENT', 'order untouched while unlinked');

      // a genuinely unmatched payment stays visible
      eq(await tx(db, (c) => apply(c, { providerOrderId: 'order_GHOST', paymentId: 'pay_GHOST', amount: 999 })), 'UNLINKED', 'ghost');

      // conflict (a): same payment id reported under another provider order that maps to another ArtQ order
      const O2 = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }] }));
      const a2 = await attempt(db, O2.orderId, O2.total);
      eq(await tx(db, (c) => apply(c, { providerOrderId: a2.providerOrderId, paymentId: 'pay_C14', amount: O.total })), 'CONFLICT', 'other order mapping');
      // conflict (b): same provider order, different amount
      eq(await tx(db, (c) => apply(c, { ...p, amount: O.total + 1 })), 'CONFLICT', 'amount identity');
      const still = await one(db, `SELECT order_id, allocation FROM payments WHERE provider_payment_id='pay_C14'`);
      eq(still, { order_id: null, allocation: 'UNLINKED' }, 'conflicts did not attach the payment');
      eq(await val(db, `SELECT status FROM orders WHERE id=$1`, [O2.orderId]), 'PENDING_PAYMENT', 'other order untouched');

      // mapping saved (TX2 or reconciler adoption); then webhook + verify + reconciler race, then repeats
      await db.query(`UPDATE payment_attempts SET provider_order_id='order_C14', status='CREATED' WHERE id=$1`, [attId]);
      const outcomes = await Promise.all(['WEBHOOK', 'CUSTOMER', 'SYSTEM', 'WEBHOOK', 'SYSTEM'].map((actor) => tx(db, (c) => apply(c, { ...p, actor }))));
      for (let i = 0; i < 3; i++) outcomes.push(await tx(db, (c) => apply(c, p)));
      eq(outcomes.filter((x) => x === 'APPLIED').length, 1, 'recovered and applied once');
      eq(outcomes.filter((x) => x === 'DUPLICATE').length, 7, 'others DUPLICATE');
      const r = (await db.query(`SELECT
        (SELECT row(order_id = $1, attempt_id = $5, allocation)::text FROM payments WHERE provider_payment_id='pay_C14') AS pay,
        (SELECT row(status, payment_status, captured_amount)::text FROM orders WHERE id=$1) AS ord,
        (SELECT row(reserved_count, redeemed_count)::text FROM coupons WHERE id=$2) AS cpn,
        (SELECT sold_count FROM products WHERE id=$3) AS sold,
        (SELECT status FROM carts WHERE id=$4) AS cart,
        (SELECT count(*) FROM order_status_history WHERE order_id=$1 AND to_value='PAID') AS hist,
        (SELECT count(*) FROM outbox_events WHERE event_type='order.placed') AS placed,
        (SELECT count(*) FROM inventory_reservations WHERE order_id=$1 AND status='ACTIVE') AS res,
        (SELECT row(status, order_id = $1)::text FROM payment_exceptions WHERE dedupe_key='UNLINKED_PAYMENT:pay_C14') AS exc,
        (SELECT status FROM payment_exceptions WHERE dedupe_key='UNLINKED_PAYMENT:pay_GHOST') AS ghost,
        (SELECT count(*) FROM payment_exceptions WHERE type='PAYMENT_IDENTITY_CONFLICT') AS conflicts`,
        [O.orderId, coupon, cat.products[0].productId, cart, attId])).rows[0];
      eq(r.pay, '(t,t,APPLIED)', 'bound to correct order and attempt'); eq(r.ord, `(PLACED,PAID,${O.total})`, 'order');
      eq(r.cpn, '(0,1)', 'coupon once'); eq(r.sold, 2, 'sold once'); eq(r.cart, 'CONVERTED', 'cart'); eq(Number(r.hist), 1, 'history once');
      eq(Number(r.placed), 1, 'order.placed once'); eq(Number(r.res), 1, 'inventory reserved once (no double reservation)');
      eq(r.exc, '(RESOLVED,t)', 'exception resolved after recovery'); eq(r.ghost, 'OPEN', 'unmatched payment still visible');
      eq(Number(r.conflicts), 2, 'conflicts recorded');
      // conflict (c): the now-bound payment reported under the other order's provider order
      eq(await tx(db, (c) => apply(c, { providerOrderId: a2.providerOrderId, paymentId: 'pay_C14', amount: O.total })), 'CONFLICT', 'bound payment cannot move');
      eq(await val(db, `SELECT status FROM orders WHERE id=$1`, [O2.orderId]), 'PENDING_PAYMENT', 'other order still untouched');
      return `capture before mapping → UNLINKED (exception OPEN); conflicting order/amount → CONFLICT, not attached; after mapping, ` +
             `8 webhook/verify/reconcile calls → ${JSON.stringify(outcomes.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {}))}; ` +
             `order ${r.ord}, coupon ${r.cpn}, sold ${r.sold}, 1 history, 1 order.placed; exception RESOLVED; ghost stays OPEN`;
    } finally { await db.end(); }
  },
};
