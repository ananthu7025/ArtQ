// Finding 6: concurrent multi-variant checkouts, releases, inventory batches, variant edits, taxonomy renames and the
// search worker, under the documented lock order + deferred search queue → no deadlocks, invariants hold.
// Negative control: the previous design (variant trigger updating the parent product immediately) deadlocks.
import { pool, tx, catalog, order, val, eq, assert } from '../lib/db.mjs';

const pick = (a, n) => [...a].sort(() => Math.random() - 0.5).slice(0, n);
const rnd = (n) => Math.floor(Math.random() * n);

async function workload(db, cat, ops, mix) {
  const variants = cat.products.flatMap((p) => p.variantIds);
  const pending = [];
  const errs = {}; let deadlocks = 0, okOps = 0;
  const one = async () => {
    const r = Math.random(); let kind;
    try {
      if (r < mix.checkout) {
        kind = 'checkout';
        const lines = pick(variants, 2 + rnd(2)).map((variantId) => ({ variantId, qty: 1 + rnd(2) }));
        const o = await tx(db, (c) => order(c, { lines }));
        pending.push(o.orderId);
      } else if (r < mix.release) {
        kind = 'release';
        const id = pending.splice(rnd(Math.max(pending.length, 1)), 1)[0];
        if (id) await tx(db, (c) => c.query(`SELECT aq_release_unpaid_order($1,'EXPIRED','t','SYSTEM')`, [id]));
      } else if (r < mix.adjust) {
        kind = 'adjust';
        const rows = pick(variants, 2 + rnd(3)).map((v) => ({ variant_id: v, kind: 'ADJUSTMENT', quantity: 1 + rnd(3) }));
        await tx(db, (c) => c.query(`SELECT aq_adjust_on_hand($1::jsonb, NULL)`, [JSON.stringify(rows)]));
      } else if (r < mix.edit) {
        kind = 'edit';
        const p = cat.products[rnd(cat.products.length)];
        const rows = pick(p.variantIds, 2).map((v) => ({ variant_id: v, color: 'c' + rnd(1000) }));
        await tx(db, (c) => c.query(`SELECT aq_edit_variants($1,$2::jsonb)`, [p.productId, JSON.stringify(rows)]));
      } else if (r < mix.rename) {
        kind = 'rename';
        await tx(db, (c) => c.query(`UPDATE categories SET name = name || '.' WHERE id = $1`, [cat.categoryId]));
      } else {
        kind = 'search';
        await tx(db, (c) => c.query(`SELECT aq_process_search_queue(200)`));
      }
      okOps++;
    } catch (e) {
      if (e.code === '40P01') deadlocks++;
      else if (!/OUT_OF_STOCK/.test(e.message)) errs[`${kind}: ${e.message}`] = (errs[`${kind}: ${e.message}`] || 0) + 1;
    }
  };
  const conc = 24; let left = ops;
  await Promise.all(Array.from({ length: conc }, async () => { while (left-- > 0) await one(); }));
  return { deadlocks, okOps, errs };
}

export default {
  id: 'C09', title: 'Multi-variant transactions + triggers: lock order holds (no deadlocks); old trigger deadlocks',
  async run({ cfg }) {
    const db = pool(cfg, 40);
    try {
      const cat = await catalog(db, [0, 1, 2].map(() => [0, 1, 2, 3].map(() => ({ price: 1000, onHand: 400 }))));
      const mix = { checkout: 0.45, release: 0.6, adjust: 0.75, edit: 0.88, rename: 0.92 };
      const w = await workload(db, cat, 1200, mix);
      await tx(db, (c) => c.query(`SELECT aq_process_search_queue(100000)`));
      const inv = await db.query(`SELECT
         (SELECT count(*) FROM variant_reservation_drift) AS res_drift,
         (SELECT count(*) FROM product_aggregate_drift) AS agg_drift,
         (SELECT count(*) FROM product_variants WHERE on_hand - reserved < 0) AS negative,
         (SELECT count(*) FROM products p WHERE p.search_vector IS DISTINCT FROM product_search_vector(p)) AS stale_search,
         (SELECT count(*) FROM search_reindex_queue) AS queued`);
      const i = inv.rows[0];
      eq(w.deadlocks, 0, 'deadlocks with documented strategy');
      eq(Object.keys(w.errs).length, 0, 'unexpected errors ' + JSON.stringify(w.errs));
      if (Number(i.stale_search) > 0) {
        const d = await db.query(`SELECT id, search_vector::text AS have, product_search_vector(p)::text AS want FROM products p
                                  WHERE p.search_vector IS DISTINCT FROM product_search_vector(p)`);
        throw new Error('stale search vectors: ' + JSON.stringify(d.rows));
      }
      eq([i.res_drift, i.agg_drift, i.negative, i.stale_search, i.queued].map(Number), [0, 0, 0, 0, 0], 'invariants');

      // Negative control: reinstate the previous immediate parent-product trigger and rerun checkout+edit traffic.
      await db.query(`CREATE OR REPLACE FUNCTION legacy_variant_trg() RETURNS trigger AS $$
        BEGIN UPDATE products SET search_vector = product_search_vector(products) WHERE id = NEW.product_id; RETURN NULL; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER legacy_variant_trg AFTER UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION legacy_variant_trg();`);
      const legacy = await workload(db, cat, 600, { checkout: 0.7, release: 0.8, adjust: 0.9, edit: 1.0, rename: 1.0 });
      await db.query(`DROP TRIGGER legacy_variant_trg ON product_variants`);
      return `documented strategy: ${w.okOps} ops at concurrency 24 → 0 deadlocks, drift/negative/stale-search/queue all 0. ` +
             `Negative control (old immediate trigger): ${legacy.deadlocks} deadlocks in 600 ops`;
    } finally { await db.end(); }
  },
};
