// Finding 9: a webhook worker whose lease expired cannot complete or fail the event after a newer worker reclaimed it.
import { pool, tx, catalog, order, attempt, apply, val, eq, rejects } from '../lib/db.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: 'C08', title: 'Webhook inbox: stalled worker resumes after reclaim → fenced out; domain change applied once',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      const cat = await catalog(db, [[{ price: 20000, onHand: 5 }]]);
      const O = await tx(db, (c) => order(c, { lines: [{ variantId: cat.products[0].variantIds[0], qty: 1 }] }));
      const a = await attempt(db, O.orderId, O.total);
      const id = await val(db, `INSERT INTO webhook_events (provider, event_id, event_type, payload) VALUES ('RAZORPAY','evt_C08','payment.captured','{}') RETURNING id`);
      const dup = await db.query(`INSERT INTO webhook_events (provider, event_id, event_type, payload) VALUES ('RAZORPAY','evt_C08','payment.captured','{}') ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`);
      eq(dup.rowCount, 0, 'duplicate receipt ignored');
      const tA = await val(db, `SELECT aq_webhook_claim($1, 1)`, [id]);             // worker A, 1 s lease, then stalls
      eq(await val(db, `SELECT aq_webhook_claim($1, 300)`, [id]), null, 'cannot claim a live lease');
      await sleep(1100);
      const tB = await val(db, `SELECT aq_webhook_claim($1, 300)`, [id]);           // worker B reclaims
      const outB = await tx(db, async (c) => {
        if (!(await val(c, `SELECT aq_webhook_begin($1,$2)`, [id, tB]))) throw new Error('B lost lease');
        const r = await apply(c, { providerOrderId: a.providerOrderId, paymentId: 'pay_C08', amount: O.total });
        await c.query(`SELECT aq_webhook_complete($1,$2)`, [id, tB]);
        return r;
      });
      eq(outB, 'APPLIED', 'B applied');
      // A resumes: begin check fails; even if it skipped the check, complete raises and rolls back its domain work
      eq(await val(db, `SELECT aq_webhook_begin($1,$2)`, [id, tA]), false, 'A fenced at begin');
      const msg = await rejects(tx(db, async (c) => {
        await apply(c, { providerOrderId: a.providerOrderId, paymentId: 'pay_C08', amount: O.total });
        await c.query(`SELECT aq_webhook_complete($1,$2)`, [id, tA]);
      }), /LEASE_LOST/, 'A complete fenced');
      eq(await val(db, `SELECT aq_webhook_fail($1,$2,'late error')`, [id, tA]), 'LEASE_LOST', 'A fail fenced');
      eq(await val(db, `SELECT status FROM webhook_events WHERE id=$1`, [id]), 'PROCESSED', 'event stays PROCESSED');
      eq(await val(db, `SELECT count(*) FROM outbox_events WHERE event_type='order.placed'`), '1', 'order.placed once');
      // renewal is fenced too
      eq(await val(db, `SELECT aq_webhook_renew($1,$2)`, [id, tA]), false, 'stale renew rejected');
      return `B completed with its token; A: begin=false, complete → ${msg}, fail → LEASE_LOST, renew rejected; status PROCESSED; one order.placed`;
    } finally { await db.end(); }
  },
};
