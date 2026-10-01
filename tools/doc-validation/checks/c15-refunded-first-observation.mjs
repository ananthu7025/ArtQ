// Review 3, finding 2: capture history ≠ eligibility to fund. Payments first observed fully/partially refunded
// never start fulfilment; provider refunds are recorded once and consume payment capacity; later and older
// observations are monotonic and side-effect free.
import { pool, tx, catalog, order, attempt, apply, val, one, eq, rejects } from '../lib/db.mjs';

export default {
  id: 'C15', title: 'Payments first observed REFUNDED / partially refunded; CAPTURED→REFUNDED; out-of-order; concurrency',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      const cat = await catalog(db, [[{ price: 10000, onHand: 50 }]]);
      const v = cat.products[0].variantIds[0];
      const mk = async () => { const o = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }] })); return { o, a: await attempt(db, o.orderId, o.total) }; };
      const placedCount = () => val(db, `SELECT count(*) FROM outbox_events WHERE event_type='order.placed'`);

      // 1. first observation: fully REFUNDED
      const F = await mk();
      eq(await tx(db, (c) => apply(c, { providerOrderId: F.a.providerOrderId, paymentId: 'pay_F', amount: F.o.total, status: 'REFUNDED', amountRefunded: F.o.total })), 'VOID', 'fully refunded first');
      const f = await one(db, `SELECT o.status, o.payment_status, o.captured_amount, p.allocation, p.refund_reserved, p.amount_refunded, p.provider_amount_refunded,
          (SELECT row(kind, status, amount)::text FROM refunds WHERE payment_id = p.id) AS rf,
          (SELECT status FROM payment_exceptions WHERE dedupe_key='REFUNDED_BEFORE_APPLY:pay_F') AS exc
        FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.id=$1`, [F.o.orderId]);
      eq(f, { status: 'PENDING_PAYMENT', payment_status: 'UNPAID', captured_amount: 0, allocation: 'VOID', refund_reserved: F.o.total,
               amount_refunded: F.o.total, provider_amount_refunded: F.o.total, rf: `(PROVIDER_INITIATED,PROCESSED,${F.o.total})`, exc: 'RESOLVED' }, 'VOID state');
      eq(await placedCount(), '0', 'no fulfilment');
      const pF = await val(db, `SELECT id FROM payments WHERE provider_payment_id='pay_F'`);
      await rejects(tx(db, (c) => c.query(`SELECT aq_request_refund($1,$2,'EXCESS_CAPTURE','[]'::jsonb,0,0,1,'x','k-f',NULL)`, [F.o.orderId, pF])),
        /REFUND_EXCEEDS_CAPACITY:payment/, 'no second refund of refunded money');
      // older CAPTURED arrives afterwards
      eq(await tx(db, (c) => apply(c, { providerOrderId: F.a.providerOrderId, paymentId: 'pay_F', amount: F.o.total, status: 'CAPTURED', amountRefunded: 0 })), 'DUPLICATE', 'older captured');
      eq(await one(db, `SELECT status, provider_amount_refunded FROM payments WHERE id=$1`, [pF]), { status: 'REFUNDED', provider_amount_refunded: F.o.total }, 'monotonic');
      eq(await val(db, `SELECT status FROM orders WHERE id=$1`, [F.o.orderId]), 'PENDING_PAYMENT', 'still not funded');

      // 2. first observation: partially refunded (Razorpay keeps status "captured" for partial refunds)
      const P = await mk();
      eq(await tx(db, (c) => apply(c, { providerOrderId: P.a.providerOrderId, paymentId: 'pay_P', amount: P.o.total, status: 'CAPTURED', amountRefunded: 3000 })), 'HELD', 'partial first');
      const pp = await one(db, `SELECT p.allocation, p.refund_reserved, (SELECT status FROM orders WHERE id=$1) AS ord,
          (SELECT status FROM payment_exceptions WHERE dedupe_key='REFUNDED_BEFORE_APPLY:pay_P') AS exc FROM payments p WHERE provider_payment_id='pay_P'`, [P.o.orderId]);
      eq(pp, { allocation: 'HELD', refund_reserved: 3000, ord: 'PENDING_PAYMENT', exc: 'OPEN' }, 'held for review');
      const pP = await val(db, `SELECT id FROM payments WHERE provider_payment_id='pay_P'`);
      await rejects(tx(db, (c) => c.query(`SELECT aq_request_refund($1,$2,'EXCESS_CAPTURE','[]'::jsonb,0,0,$3,'x','k-p1',NULL)`, [P.o.orderId, pP, P.o.total - 3000 + 1])),
        /REFUND_EXCEEDS_CAPACITY:payment/, 'cannot refund more than the remainder');
      await tx(db, (c) => c.query(`SELECT aq_request_refund($1,$2,'EXCESS_CAPTURE','[]'::jsonb,0,0,$3,'x','k-p2',NULL)`, [P.o.orderId, pP, P.o.total - 3000]));
      eq(await placedCount(), '0', 'still no fulfilment');

      // 3. CAPTURED then REFUNDED (our own refund) → reconciled, no mismatch; external refund → RECON_MISMATCH only
      const C = await mk();
      eq(await tx(db, (c) => apply(c, { providerOrderId: C.a.providerOrderId, paymentId: 'pay_C', amount: C.o.total })), 'APPLIED', 'captured');
      const pC = await val(db, `SELECT id FROM payments WHERE provider_payment_id='pay_C'`);
      const rC = await tx(db, (c) => val(c, `SELECT aq_request_refund($1,$2,'RETURN',$3::jsonb,0,0,0,'x','k-c',NULL)`,
        [C.o.orderId, pC, JSON.stringify([{ order_item_id: C.o.items[0].orderItemId, quantity: 1, amount: C.o.total }])]));
      await tx(db, (c) => c.query(`SELECT aq_mark_refund_processed($1,'rfnd_C')`, [rC]));
      eq(await tx(db, (c) => apply(c, { providerOrderId: C.a.providerOrderId, paymentId: 'pay_C', amount: C.o.total, status: 'REFUNDED', amountRefunded: C.o.total })), 'DUPLICATE', 'refunded later');
      eq(await val(db, `SELECT count(*) FROM payment_exceptions WHERE payment_id=$1 AND type='RECON_MISMATCH'`, [pC]), '0', 'own refund reconciles');
      const X = await mk();
      await tx(db, (c) => apply(c, { providerOrderId: X.a.providerOrderId, paymentId: 'pay_X', amount: X.o.total }));
      eq(await tx(db, (c) => apply(c, { providerOrderId: X.a.providerOrderId, paymentId: 'pay_X', amount: X.o.total, status: 'REFUNDED', amountRefunded: X.o.total })), 'DUPLICATE', 'dashboard refund');
      const x = await one(db, `SELECT o.status, o.refunded_amount, (SELECT count(*) FROM refunds WHERE order_id=o.id) AS refunds,
          (SELECT count(*) FROM payment_exceptions e JOIN payments p ON p.id = e.payment_id WHERE p.provider_payment_id='pay_X' AND e.type='RECON_MISMATCH') AS mism
        FROM orders o WHERE o.id=$1`, [X.o.orderId]);
      eq(x, { status: 'PLACED', refunded_amount: 0, refunds: '0', mism: '1' }, 'unexplained provider refund surfaced, totals untouched, no new refund');
      // repeat: no second exception
      await tx(db, (c) => apply(c, { providerOrderId: X.a.providerOrderId, paymentId: 'pay_X', amount: X.o.total, status: 'REFUNDED', amountRefunded: X.o.total }));
      eq(await val(db, `SELECT count(*) FROM payment_exceptions WHERE type='RECON_MISMATCH'`), '1', 'deduped');

      // 4. concurrent first observations, fully refunded
      const Z = await mk();
      const zs = await Promise.all(Array.from({ length: 6 }, () => tx(db, (c) => apply(c, { providerOrderId: Z.a.providerOrderId, paymentId: 'pay_Z', amount: Z.o.total, status: 'REFUNDED', amountRefunded: Z.o.total }))));
      eq(zs.filter((s) => s === 'VOID').length, 1, 'one VOID'); eq(zs.filter((s) => s === 'DUPLICATE').length, 5, 'rest DUPLICATE');
      eq(await val(db, `SELECT count(*) FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.provider_payment_id='pay_Z'`), '1', 'one provider refund record');

      // 5. concurrent mixed CAPTURED / REFUNDED first observations: never both funded and voided
      const M = await mk(); const before = Number(await placedCount());
      const ms = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => tx(db, (c) => apply(c, i % 2
        ? { providerOrderId: M.a.providerOrderId, paymentId: 'pay_M', amount: M.o.total, status: 'REFUNDED', amountRefunded: M.o.total }
        : { providerOrderId: M.a.providerOrderId, paymentId: 'pay_M', amount: M.o.total }))));
      const alloc = ms.filter((s) => s !== 'DUPLICATE');
      eq(alloc.length, 1, 'exactly one allocation');
      const m = await one(db, `SELECT p.allocation, p.status, (SELECT count(*) FROM refunds WHERE payment_id=p.id) AS refunds FROM payments p WHERE provider_payment_id='pay_M'`);
      eq(m.status, 'REFUNDED', 'final status monotonic');
      eq(Number(await placedCount()) - before, alloc[0] === 'APPLIED' ? 1 : 0, 'fulfilment only if funded');
      eq(Number(m.refunds), alloc[0] === 'VOID' ? 1 : 0, 'provider refund recorded only if voided');
      return `fully refunded first → VOID (order unpaid, PROCESSED provider refund, capacity exhausted, exception RESOLVED); older CAPTURED after → DUPLICATE, status stays REFUNDED; ` +
             `partial first → HELD (exception OPEN, only remainder refundable); CAPTURED→REFUNDED reconciles own refund, dashboard refund → 1 RECON_MISMATCH, totals untouched; ` +
             `6 concurrent refunded → 1 VOID; mixed race → ${alloc[0]} once (${JSON.stringify(ms)})`;
    } finally { await db.end(); }
  },
};
