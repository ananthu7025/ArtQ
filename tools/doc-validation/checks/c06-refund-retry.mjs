// Findings 3+4: a FAILED refund releases capacity; retry reacquires atomically and cannot bypass a newer refund;
// each new attempt gets a new X-Refund-Idempotency key + receipt, unknown outcomes keep the same attempt.
import { pool, tx, catalog, order, attempt, apply, val, one, eq, rejects } from '../lib/db.mjs';

export default {
  id: 'C06', title: 'Failed-refund retry after capacity is reused; provider idempotency keys per attempt',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      const cat = await catalog(db, [[{ price: 100000, onHand: 5 }]]);
      const O = await tx(db, (c) => order(c, { lines: [{ variantId: cat.products[0].variantIds[0], qty: 1 }] }));
      const a = await attempt(db, O.orderId, O.total);
      await tx(db, (c) => apply(c, { providerOrderId: a.providerOrderId, paymentId: 'pay_C06', amount: O.total }));
      const pay = await val(db, `SELECT id FROM payments WHERE provider_payment_id='pay_C06'`);
      const item = [{ order_item_id: O.items[0].orderItemId, quantity: 1, amount: 60000 }];
      const A = await tx(db, (c) => val(c, `SELECT aq_request_refund($1,$2,'RETURN',$3::jsonb,0,0,0,'a','key-A',NULL)`, [O.orderId, pay, JSON.stringify(item)]));
      const a1 = await one(db, `SELECT id, provider_idempotency_key, receipt, request FROM refund_attempts WHERE refund_id=$1`, [A]);
      // timeout: outcome unknown → same attempt stays current (resend with SAME key + SAME request)
      eq(await tx(db, (c) => val(c, `SELECT aq_refund_attempt_result($1,'UNKNOWN',NULL,NULL,NULL)`, [a1.id])), 'UNKNOWN', 'unknown');
      eq(await val(db, `SELECT count(*) FROM refund_attempts WHERE refund_id=$1`, [A]), '1', 'no new attempt on unknown');
      // definitive failure → capacity released
      eq(await tx(db, (c) => val(c, `SELECT aq_refund_attempt_result($1,'FAILED',400,'{"description":"x"}',NULL)`, [a1.id])), 'FAILED', 'failed');
      eq(await val(db, `SELECT refund_reserved_amount FROM order_items WHERE id=$1`, [O.items[0].orderItemId]), 0, 'released');
      // a newer refund takes the capacity
      const B = await tx(db, (c) => val(c, `SELECT aq_request_refund($1,$2,'RETURN',$3::jsonb,0,0,0,'b','key-B',NULL)`, [O.orderId, pay, JSON.stringify(item)]));
      const msg = await rejects(tx(db, (c) => c.query(`SELECT aq_retry_refund($1)`, [A])), /REFUND_EXCEEDS_CAPACITY/, 'retry must not bypass newer refund');
      eq(await val(db, `SELECT status FROM refunds WHERE id=$1`, [A]), 'FAILED', 'A stays FAILED after rejected retry');
      // B fails too → A can be retried, with a NEW key and receipt
      const b1 = await val(db, `SELECT id FROM refund_attempts WHERE refund_id=$1`, [B]);
      await tx(db, (c) => c.query(`SELECT aq_refund_attempt_result($1,'FAILED',400,'{}',NULL)`, [b1]));
      eq(await tx(db, (c) => val(c, `SELECT aq_retry_refund($1)`, [A])), 2, 'retry → attempt 2');
      const a2 = await one(db, `SELECT provider_idempotency_key, receipt FROM refund_attempts WHERE refund_id=$1 AND attempt_no=2`, [A]);
      eq(a2.provider_idempotency_key !== a1.provider_idempotency_key && a2.receipt !== a1.receipt, true, 'new key and receipt');
      // stale result for attempt 1 cannot change the refund now on attempt 2
      eq(await tx(db, (c) => val(c, `SELECT aq_refund_attempt_result($1,'ACCEPTED_PROCESSED',200,'{}','rfnd_old')`, [a1.id])), 'STALE', 'stale attempt result');
      // concurrent retries of a FAILED refund: one wins
      await tx(db, (c) => c.query(`SELECT aq_refund_attempt_result((SELECT id FROM refund_attempts WHERE refund_id=$1 AND attempt_no=2),'FAILED',400,'{}',NULL)`, [A]));
      const rr = await Promise.allSettled([1, 2, 3, 4].map(() => tx(db, (c) => c.query(`SELECT aq_retry_refund($1)`, [A]))));
      eq(rr.filter((x) => x.status === 'fulfilled').length, 1, 'one concurrent retry wins');
      // the request payload is immutable per attempt: key format check
      await rejects(db.query(`UPDATE refund_attempts SET provider_idempotency_key='short' WHERE refund_id=$1`, [A]), /refund_attempts_key_ck/, 'key format');
      return `attempt1 key ${a1.provider_idempotency_key} (receipt ${a1.receipt}); retry blocked: ${msg}; after B failed → attempt 2 key ${a2.provider_idempotency_key}; stale attempt result ignored; 4 concurrent retries → 1`;
    } finally { await db.end(); }
  },
};
