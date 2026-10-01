// Finding 10: partial dimensions; inspection quantities; finalisation guard. Also shows the previous expressions' NULL hole.
import { pool, tx, catalog, order, val, eq, rejects } from '../lib/db.mjs';

export default {
  id: 'C11', title: 'Constraints: partial dimensions and invalid/incomplete return inspection rejected',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      const cat = await catalog(db, [[{ price: 1000, onHand: 5 }]]);
      const v = cat.products[0].variantIds[0];
      const oldDims = await val(db, `SELECT ((NULL::numeric IS NULL AND 5 IS NULL AND 5 IS NULL) OR (NULL::numeric > 0 AND 5 > 0 AND 5 > 0)) IS NOT FALSE`);
      eq(oldDims, true, 'previous dims expression let a partial row through');
      for (const d of [[10, null, null], [10, 5, null], [10, 5, 0], [-1, 5, 5]]) {
        await rejects(db.query(`UPDATE product_variants SET length_cm=$2, width_cm=$3, height_cm=$4 WHERE id=$1`, [v, ...d]), /variants_dims_ck/, `dims ${d}`);
      }
      await db.query(`UPDATE product_variants SET length_cm=10, width_cm=5, height_cm=2 WHERE id=$1`, [v]);
      await db.query(`UPDATE product_variants SET length_cm=NULL, width_cm=NULL, height_cm=NULL WHERE id=$1`, [v]);

      const O = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 3 }], reserve: false }));
      const rr = await val(db, `INSERT INTO return_requests (order_id, reason, updated_at) VALUES ($1,'DAMAGED',now()) RETURNING id`, [O.orderId]);
      await db.query(`INSERT INTO return_request_items (return_request_id, order_item_id, requested_qty, approved_qty, received_qty) VALUES ($1,$2,3,3,2)`, [rr, O.items[0].orderItemId]);
      const upd = (s, d) => db.query(`UPDATE return_request_items SET sellable_qty=$2, damaged_qty=$3 WHERE return_request_id=$1`, [rr, s, d]);
      const oldInspect = await val(db, `SELECT (-1 + 3 = 2)`);
      eq(oldInspect, true, 'previous check accepted -1 sellable + 3 damaged = 2 received');
      for (const [s, d] of [[-1, 3], [3, -1], [2, null], [null, 1], [3, 0], [1, 0]]) await rejects(upd(s, d), /return_items_qty_ck/, `inspect ${s}/${d}`);
      await rejects(db.query(`UPDATE return_requests SET status='INSPECTED' WHERE id=$1`, [rr]), /incomplete item inspection/, 'finalise incomplete');
      await upd(1, 1);
      await db.query(`UPDATE return_requests SET status='INSPECTED' WHERE id=$1`, [rr]);
      return 'partial/zero/negative dims rejected (old expression evaluated to NULL ⇒ passed); sellable/damaged negative, one-sided, over-received or not summing rejected; INSPECTED blocked until items complete';
    } finally { await db.end(); }
  },
};
