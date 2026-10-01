// Finding 7: idempotency fingerprint covers operation + target resource + scope + canonical body.
import { createHash } from 'node:crypto';
import { pool, tx, val, one, eq } from '../lib/db.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reference fingerprint (api.md §1.2): sha256 of canonical JSON with sorted keys.
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',')}}` : JSON.stringify(v);
export const fingerprint = ({ operation, target, scope, body }) => createHash('sha256').update(canon({ operation, target, scope, body })).digest('hex');

const begin = (q, scope, op, key, target, hash, lock = 60) =>
  one(q, `SELECT * FROM aq_idempotency_begin($1,$2,$3,$4,$5,$6)`, [scope, op, key, target, hash, lock]);

export default {
  id: 'C10', title: 'Idempotency: cross-resource key reuse conflicts; replay; in-progress; takeover; concurrent begin',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      const body = { items: [{ orderItemId: 1, quantity: 1, amount: 45000 }], reason: 'damaged' };
      const scope = 'staff:7', op = 'refund.create', key = 'k-123e4567-e89b';
      const h1 = fingerprint({ operation: op, target: 'order:101', scope, body });
      const h2 = fingerprint({ operation: op, target: 'order:202', scope, body });
      eq(h1 !== h2, true, 'fingerprint differs by target');
      eq((await begin(db, scope, op, key, 'order:101', h1)).outcome, 'NEW', 'first');
      await db.query(`SELECT aq_idempotency_complete($1,$2,$3,201,'{"refundId":9}'::jsonb,'refund','9')`, [scope, op, key]);
      eq((await begin(db, scope, op, key, 'order:101', h1)).outcome, 'REPLAY', 'same target+body replays');
      eq((await begin(db, scope, op, key, 'order:202', h2)).outcome, 'CONFLICT', 'same key+body, other order');
      eq((await begin(db, scope, op, key, 'order:202', h1)).outcome, 'CONFLICT', 'even if a client bug reuses the hash');
      // per-operation coverage: cancellation, payment retry, returns use the same function with their own targets
      for (const [o2, t1, t2] of [['order.cancel', 'order:AQ1', 'order:AQ2'], ['payment.retry', 'order:AQ1', 'order:AQ2'], ['return.create', 'order:AQ1', 'order:AQ2']]) {
        const b = { reason: 'x' };
        eq((await begin(db, 'user:5', o2, 'k-same-key-01', t1, fingerprint({ operation: o2, target: t1, scope: 'user:5', body: b }))).outcome, 'NEW', o2);
        eq((await begin(db, 'user:5', o2, 'k-same-key-01', t2, fingerprint({ operation: o2, target: t2, scope: 'user:5', body: b }))).outcome, 'CONFLICT', o2 + ' cross-resource');
      }
      // in progress, then takeover after lock expiry
      const hk = fingerprint({ operation: 'checkout.initiate', target: 'cart:1', scope: 'cart:1', body: {} });
      eq((await begin(db, 'cart:1', 'checkout.initiate', 'k-checkout-1', 'cart:1', hk, 1)).outcome, 'NEW', 'checkout');
      eq((await begin(db, 'cart:1', 'checkout.initiate', 'k-checkout-1', 'cart:1', hk, 1)).outcome, 'IN_PROGRESS', 'in progress');
      await sleep(1100);
      eq((await begin(db, 'cart:1', 'checkout.initiate', 'k-checkout-1', 'cart:1', hk, 60)).outcome, 'TAKEOVER', 'takeover after crash');
      // 10 concurrent identical requests → exactly one NEW
      const hc = fingerprint({ operation: 'checkout.initiate', target: 'cart:2', scope: 'cart:2', body: {} });
      const rs = await Promise.all(Array.from({ length: 10 }, () => tx(db, (c) => begin(c, 'cart:2', 'checkout.initiate', 'k-checkout-2', 'cart:2', hc))));
      const counts = rs.reduce((m, r) => ((m[r.outcome] = (m[r.outcome] || 0) + 1), m), {});
      eq(counts.NEW, 1, 'one NEW'); eq(counts.IN_PROGRESS, 9, 'others in progress');
      return `refund key reused on order:202 → CONFLICT (also with identical hash); cancel/retry/return cross-resource → CONFLICT; replay, in-progress, takeover OK; 10 concurrent → ${JSON.stringify(counts)}`;
    } finally { await db.end(); }
  },
};
