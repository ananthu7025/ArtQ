// Finding 5: outbox claim (short TX) → publish to BullMQ outside any TX → fenced ack. Redis loses the
// accepted job; PostgreSQL still knows the work is outstanding and redelivers it; the consumer dedupes.
import { Queue, Worker } from 'bullmq';
import { pool, tx, val, one, eq, assert } from '../lib/db.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dispatchOnce(db, queue, redeliverS) {
  const { rows } = await tx(db, (c) => c.query(`SELECT * FROM aq_outbox_claim(100, 30, $1, 10)`, [redeliverS]));   // short TX
  for (const d of rows) {                                                                                        // network outside TX
    try {
      await queue.add(d.consumer, { deliveryId: String(d.delivery_id) }, { jobId: `outbox-${d.delivery_id}-${d.generation}`, removeOnComplete: { age: 7 * 86400 } });
      await db.query(`SELECT aq_outbox_mark_published($1,$2)`, [d.delivery_id, d.lease_token]);                  // fenced ack
    } catch (e) {
      await db.query(`SELECT aq_outbox_publish_failed($1,$2,$3)`, [d.delivery_id, d.lease_token, e.message]);
    }
  }
  return rows;
}

export default {
  id: 'C07', title: 'Outbox: Redis loses a published job → redelivered from PostgreSQL; consumer dedupe; lease fencing', needs: ['redis'],
  async run({ cfg, redis }) {
    const db = pool(cfg);
    const queue = new Queue('outbox-c07', { connection: redis.connection });
    let effects = 0, dupSkips = 0;
    const worker = new Worker('outbox-c07', async (job) => {
      await tx(db, async (c) => {
        const go = await val(c, `SELECT aq_outbox_begin_consume($1)`, [job.data.deliveryId]);
        if (!go) { dupSkips++; return; }
        await c.query(`INSERT INTO email_logs (dedupe_key, to_email, template, subject, outbox_delivery_id, status, updated_at)
                       VALUES ('order.placed:C07:customer','b@x.in','order_placed','s',$1,'SENT',now())`, [job.data.deliveryId]);
        effects++;
        await c.query(`SELECT aq_outbox_complete($1)`, [job.data.deliveryId]);
      });
    }, { connection: redis.connection, autorun: false });
    try {
      const ev = await tx(db, (c) => val(c, `SELECT aq_emit('order','AQ-C07','order.placed','{}'::jsonb, ARRAY['email.customer'])`));
      const d1 = await dispatchOnce(db, queue, 3600);
      eq(d1.length, 1, 'claimed'); eq(d1[0].generation, 1, 'gen 1');
      eq(await val(db, `SELECT status FROM outbox_deliveries WHERE event_id=$1`, [ev]), 'PUBLISHED', 'published = broker accepted');
      const conn = await queue.client; await conn.flushall();                         // Redis loses the accepted job
      eq((await queue.getJobCounts('waiting')).waiting, 0, 'job lost');
      eq((await dispatchOnce(db, queue, 3600)).length, 0, 'not redelivered before timeout');
      await sleep(1100);
      const d2 = await dispatchOnce(db, queue, 1);                                       // redeliver-after elapsed
      eq(d2.length, 1, 'reclaimed'); eq(d2[0].generation, 2, 'gen 2');
      await queue.add('email.customer', { deliveryId: String(d2[0].delivery_id) }, { jobId: `outbox-${d2[0].delivery_id}-1` }); // stale duplicate
      worker.run();
      for (let i = 0; i < 50 && (effects + dupSkips) < 2; i++) await sleep(100);
      const st = await one(db, `SELECT status, generation, completed_at IS NOT NULL AS done FROM outbox_deliveries WHERE event_id=$1`, [ev]);
      eq(st, { status: 'COMPLETED', generation: 2, done: true }, 'delivery completed');
      eq(effects, 1, 'effect once'); eq(dupSkips, 1, 'duplicate skipped');
      eq(await val(db, `SELECT count(*) FROM email_logs WHERE dedupe_key='order.placed:C07:customer'`), '1', 'one email log');
      // fencing: an expired lease holder cannot ack
      const ev2 = await tx(db, (c) => val(c, `SELECT aq_emit('order','AQ-C07b','order.placed','{}'::jsonb, ARRAY['email.customer'])`));
      const [x1] = (await tx(db, (c) => c.query(`SELECT * FROM aq_outbox_claim(100, 1, 3600, 10)`))).rows;
      await sleep(1100);
      const [x2] = (await tx(db, (c) => c.query(`SELECT * FROM aq_outbox_claim(100, 30, 3600, 10)`))).rows;
      eq(x2.delivery_id, x1.delivery_id, 'same delivery reclaimed');
      eq(await val(db, `SELECT aq_outbox_mark_published($1,$2)`, [x1.delivery_id, x1.lease_token]), false, 'stale owner ack rejected');
      eq(await val(db, `SELECT aq_outbox_mark_published($1,$2)`, [x2.delivery_id, x2.lease_token]), true, 'current owner ack');
      // dead after max generations
      await db.query(`UPDATE outbox_deliveries SET status='PENDING', generation=10 WHERE event_id=$1`, [ev2]);
      await tx(db, (c) => c.query(`SELECT * FROM aq_outbox_claim(100, 30, 3600, 10)`));
      eq(await val(db, `SELECT status FROM outbox_deliveries WHERE event_id=$1`, [ev2]), 'DEAD', 'dead after max generations');
      assert(await val(db, `SELECT count(*) FROM payment_exceptions WHERE type='OUTBOX_DEAD'`) === '1', 'OUTBOX_DEAD exception');
      return 'published job flushed from Redis → reclaimed after redeliver timeout as generation 2 (jobId outbox-<delivery>-2); stale gen-1 job skipped by consumer; 1 effect; expired lease holder ack rejected; DEAD + exception after max generations';
    } finally { await worker.close(); await queue.obliterate({ force: true }).catch(() => {}); await queue.close(); await db.end(); }
  },
};
