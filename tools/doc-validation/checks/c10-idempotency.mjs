// Finding 7 (review 2) + takeover fencing (review 3): fingerprint covers operation + target + scope + body;
// NEW/TAKEOVER issue a fresh owner token; stale owners cannot attach, renew or complete; takeover resumes
// existing resources instead of recreating them.
import { createHash } from 'node:crypto';
import { pool, tx, catalog, order, attempt, apply, val, one, eq, rejects } from '../lib/db.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reference fingerprint (api.md §1.2): sha256 of canonical JSON with sorted keys.
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',')}}` : JSON.stringify(v);
export const fingerprint = ({ operation, target, scope, body }) => createHash('sha256').update(canon({ operation, target, scope, body })).digest('hex');

const begin = (q, scope, op, key, target, hash, lock = 60) =>
  one(q, `SELECT * FROM aq_idempotency_begin($1,$2,$3,$4,$5,$6)`, [scope, op, key, target, hash, lock]);
const complete = (q, scope, op, key, token, code, body, rtype = null, rid = null) =>
  q.query(`SELECT aq_idempotency_complete($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [scope, op, key, token, code, JSON.stringify(body), rtype, rid]);

export default {
  id: 'C10', title: 'Idempotency: cross-resource conflicts; replay; fenced takeover (stale owner rejected, resume not recreate)',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      // ── A. fingerprint / cross-resource reuse ───────────────────────────
      const body = { items: [{ orderItemId: 1, quantity: 1, amount: 45000 }], reason: 'damaged' };
      const scope = 'staff:7', op = 'refund.create', key = 'k-123e4567-e89b';
      const h1 = fingerprint({ operation: op, target: 'order:101', scope, body });
      const h2 = fingerprint({ operation: op, target: 'order:202', scope, body });
      eq(h1 !== h2, true, 'fingerprint differs by target');
      const n1 = await begin(db, scope, op, key, 'order:101', h1);
      eq([n1.outcome, n1.generation, !!n1.owner_token], ['NEW', 1, true], 'NEW issues token, generation 1');
      await complete(db, scope, op, key, n1.owner_token, 201, { refundId: 9 }, 'refund', '9');
      eq((await begin(db, scope, op, key, 'order:101', h1)).outcome, 'REPLAY', 'same target+body replays');
      eq((await begin(db, scope, op, key, 'order:202', h2)).outcome, 'CONFLICT', 'same key+body, other order');
      eq((await begin(db, scope, op, key, 'order:202', h1)).outcome, 'CONFLICT', 'even if a client bug reuses the hash');
      for (const [o2, t1, t2] of [['order.cancel', 'order:AQ1', 'order:AQ2'], ['payment.retry', 'order:AQ1', 'order:AQ2'], ['return.create', 'order:AQ1', 'order:AQ2']]) {
        const b = { reason: 'x' };
        eq((await begin(db, 'user:5', o2, 'k-same-key-01', t1, fingerprint({ operation: o2, target: t1, scope: 'user:5', body: b }))).outcome, 'NEW', o2);
        eq((await begin(db, 'user:5', o2, 'k-same-key-01', t2, fingerprint({ operation: o2, target: t2, scope: 'user:5', body: b }))).outcome, 'CONFLICT', o2 + ' cross-resource');
      }

      // ── B. checkout: A owns, creates the order, stalls; B takes over and resumes ──
      const cat = await catalog(db, [[{ price: 25000, onHand: 5 }]]);
      const v = cat.products[0].variantIds[0];
      const cart = await val(db, `INSERT INTO carts (token_hash, updated_at) VALUES (md5('c10')||md5('c10x'), now()) RETURNING id`);
      const cs = `cart:${cart}`, cop = 'checkout.initiate', ck = 'k-checkout-fence-1', ch = fingerprint({ operation: cop, target: cs, scope: cs, body: {} });
      const A = await begin(db, cs, cop, ck, cs, ch, 1);
      eq(A.outcome, 'NEW', 'A owns');
      const O = await tx(db, async (c) => {                              // A's TX1: ownership + order + resource link, atomically
        await c.query(`SELECT aq_idempotency_assert_owner($1,$2,$3,$4)`, [cs, cop, ck, A.owner_token]);
        const o = await order(c, { lines: [{ variantId: v, qty: 1 }], cartId: cart });
        await c.query(`SELECT aq_idempotency_attach($1,$2,$3,$4,'order',$5)`, [cs, cop, ck, A.owner_token, o.orderNumber]);
        return o;
      });
      eq((await begin(db, cs, cop, ck, cs, ch, 60)).outcome, 'IN_PROGRESS', 'live lease');
      await sleep(1100);                                                 // A stalls past its lease
      const B = await begin(db, cs, cop, ck, cs, ch, 60);
      eq([B.outcome, B.resource_type, B.resource_id, B.generation], ['TAKEOVER', 'order', O.orderNumber, 2], 'B takes over and gets the resource');
      eq(B.owner_token !== A.owner_token, true, 'fresh token');
      // B resumes: no second order; continues with the existing order's payment attempt
      const att = await tx(db, async (c) => {
        await c.query(`SELECT aq_idempotency_assert_owner($1,$2,$3,$4)`, [cs, cop, ck, B.owner_token]);
        return attempt(c, O.orderId, O.total);
      });
      eq(await val(db, `SELECT count(*) FROM orders WHERE cart_id=$1`, [cart]), '1', 'resumed, not recreated');
      // A resumes: every stale-owner action is rejected and its domain mutation rolls back
      const before = await val(db, `SELECT count(*) FROM payment_attempts WHERE order_id=$1`, [O.orderId]);
      const m1 = await rejects(tx(db, async (c) => {
        await c.query(`INSERT INTO payment_attempts (order_id, receipt, amount, status, updated_at) VALUES ($1,'AQA_STALE',$2,'CLOSED',now())`, [O.orderId, O.total]);
        await c.query(`SELECT aq_idempotency_attach($1,$2,$3,$4,'attempt','stale')`, [cs, cop, ck, A.owner_token]);
      }), /IDEMPOTENCY_OWNERSHIP_LOST/, 'stale attach');
      eq(await val(db, `SELECT count(*) FROM payment_attempts WHERE order_id=$1`, [O.orderId]), before, 'stale mutation rolled back');
      await rejects(tx(db, (c) => c.query(`SELECT aq_idempotency_assert_owner($1,$2,$3,$4)`, [cs, cop, ck, A.owner_token])), /IDEMPOTENCY_OWNERSHIP_LOST/, 'stale assert');
      eq(await val(db, `SELECT aq_idempotency_renew($1,$2,$3,$4,60)`, [cs, cop, ck, A.owner_token]), false, 'stale renew');
      await rejects(complete(db, cs, cop, ck, A.owner_token, 201, { by: 'A' }), /IDEMPOTENCY_OWNERSHIP_LOST/, 'stale complete');
      eq(await val(db, `SELECT aq_idempotency_renew($1,$2,$3,$4,60)`, [cs, cop, ck, B.owner_token]), true, 'owner renew');
      await complete(db, cs, cop, ck, B.owner_token, 201, { by: 'B', orderNumber: O.orderNumber, attemptId: att.attemptId });
      await rejects(complete(db, cs, cop, ck, A.owner_token, 201, { by: 'A' }), /IDEMPOTENCY_OWNERSHIP_LOST/, 'stale complete after B');
      const rp = await begin(db, cs, cop, ck, cs, ch);
      eq([rp.outcome, rp.response_body.by], ['REPLAY', 'B'], 'replays B');

      // ── C. refund: takeover resumes the refund; provider key + request unchanged ──
      const R = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }] }));
      const ra = await attempt(db, R.orderId, R.total);
      await tx(db, (c) => apply(c, { providerOrderId: ra.providerOrderId, paymentId: 'pay_C10R', amount: R.total }));
      const pay = await val(db, `SELECT id FROM payments WHERE provider_payment_id='pay_C10R'`);
      const rs = 'staff:3', rk = 'k-refund-fence-1', rt = `order:${R.orderNumber}`;
      const rbody = { items: [{ orderItemId: R.items[0].orderItemId, quantity: 1, amount: 25000 }] };
      const rh = fingerprint({ operation: 'refund.create', target: rt, scope: rs, body: rbody });
      const RA = await begin(db, rs, 'refund.create', rk, rt, rh, 1);
      const refundId = await tx(db, async (c) => {
        await c.query(`SELECT aq_idempotency_assert_owner($1,'refund.create',$2,$3)`, [rs, rk, RA.owner_token]);
        const id = await val(c, `SELECT aq_request_refund($1,$2,'RETURN',$3::jsonb,0,0,0,'r',$4,NULL)`,
          [R.orderId, pay, JSON.stringify([{ order_item_id: R.items[0].orderItemId, quantity: 1, amount: 25000 }]), rk]);
        await c.query(`SELECT aq_idempotency_attach($1,'refund.create',$2,$3,'refund',$4)`, [rs, rk, RA.owner_token, String(id)]);
        return id;
      });
      const keyBefore = await one(db, `SELECT provider_idempotency_key, request FROM refund_attempts WHERE refund_id=$1`, [refundId]);
      await sleep(1100);
      const RB = await begin(db, rs, 'refund.create', rk, rt, rh, 60);
      eq([RB.outcome, RB.resource_type, RB.resource_id], ['TAKEOVER', 'refund', String(refundId)], 'refund takeover sees resource');
      await complete(db, rs, 'refund.create', rk, RB.owner_token, 201, { refundId, status: 'REQUESTED' });   // resume: no new refund
      const keyAfter = await one(db, `SELECT provider_idempotency_key, request FROM refund_attempts WHERE refund_id=$1`, [refundId]);
      eq(await val(db, `SELECT count(*) FROM refunds WHERE order_id=$1`, [R.orderId]), '1', 'one refund');
      eq(keyAfter, keyBefore, 'provider key + immutable request preserved');

      // ── D. concurrent takeover: exactly one current owner ───────────────
      const ds = 'cart:777', dk = 'k-concurrent-takeover', dh = fingerprint({ operation: cop, target: ds, scope: ds, body: {} });
      const D0 = await begin(db, ds, cop, dk, ds, dh, 1);
      await sleep(1100);
      const rsD = await Promise.all(Array.from({ length: 10 }, () => tx(db, (c) => begin(c, ds, cop, dk, ds, dh, 60))));
      const winners = rsD.filter((r) => r.outcome === 'TAKEOVER');
      eq(winners.length, 1, 'one TAKEOVER'); eq(rsD.filter((r) => r.outcome === 'IN_PROGRESS').length, 9, 'others in progress');
      const cur = await one(db, `SELECT owner_token, generation FROM idempotency_keys WHERE key=$1`, [dk]);
      eq([cur.owner_token, cur.generation], [winners[0].owner_token, 2], 'stored owner is the single winner');
      await rejects(complete(db, ds, cop, dk, D0.owner_token, 201, {}), /IDEMPOTENCY_OWNERSHIP_LOST/, 'original owner fenced');

      // ── E. 10 concurrent NEW → exactly one owner ────────────────────────
      const hc = fingerprint({ operation: cop, target: 'cart:2', scope: 'cart:2', body: {} });
      const rs2 = await Promise.all(Array.from({ length: 10 }, () => tx(db, (c) => begin(c, 'cart:2', cop, 'k-checkout-2', 'cart:2', hc))));
      const counts = rs2.reduce((m, r) => ((m[r.outcome] = (m[r.outcome] || 0) + 1), m), {});
      eq(counts.NEW, 1, 'one NEW'); eq(counts.IN_PROGRESS, 9, 'others in progress');
      return `cross-resource → CONFLICT; checkout: A stalled, B TAKEOVER (gen 2, resource ${O.orderNumber}) resumed without a second order; ` +
             `A's attach (${m1.slice(0, 40)}…), assert, renew, complete all rejected and its insert rolled back; replay returns B; ` +
             `refund takeover resumed refund ${refundId} with unchanged provider key; concurrent takeover → 1 owner (gen 2); concurrent NEW ${JSON.stringify(counts)}`;
    } finally { await db.end(); }
  },
};
