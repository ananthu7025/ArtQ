// Carried-over integrity checks + publish gate (DB backstop vs service-only rules).
import { pool, tx, catalog, order, attempt, apply, val, eq, rejects } from '../lib/db.mjs';

export default {
  id: 'C12', title: 'Publish gate trigger; stock/coupon final unit; invoice & order-item immutability',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      const cat = await catalog(db, [[{ price: 1000, onHand: 5 }]]);
      const p = cat.products[0].productId, v = cat.products[0].variantIds[0];
      const pub = () => db.query(`UPDATE products SET status='ACTIVE', is_publishable=true, published_at=now() WHERE id=$1`, [p]);
      const m1 = await rejects(pub(), /NOT_PUBLISHABLE/, 'gate');
      await db.query(`UPDATE products SET hsn_code='3907', gst_rate=18, tax_approved_at=now() WHERE id=$1`, [p]);
      await db.query(`UPDATE product_variants SET weight_g=350, weight_source='MEASURED' WHERE id=$1`, [v]);
      await tx(db, (c) => c.query(`SELECT aq_adjust_on_hand($1::jsonb, NULL)`, [JSON.stringify([{ variant_id: v, kind: 'RECOUNT', quantity: 5 }])]));
      const m2 = await rejects(pub(), /NOT_PUBLISHABLE: no_image/, 'image still missing');
      const media = await val(db, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, updated_at)
                                   VALUES ('k1','PUBLIC','IMAGE','image/webp',10,'admin','PROCESSING',now()) RETURNING id`);
      await db.query(`INSERT INTO product_images (product_id, media_id, is_cover) VALUES ($1,$2,true)`, [p, media]);
      await rejects(pub(), /no_image/, 'PROCESSING image is not ready');
      await db.query(`UPDATE media SET status='READY' WHERE id=$1`, [media]);
      await pub();
      await db.query(`UPDATE media SET status='FAILED' WHERE id=$1`, [media]);   // a later change the trigger cannot see
      eq(await val(db, `SELECT count(*) FROM published_not_ready`), '1', 'drift view catches post-publish breakage');

      const st = await Promise.allSettled(Array.from({ length: 12 }, () => tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }] }))));
      eq(st.filter((x) => x.status === 'fulfilled').length, 5, 'exactly on_hand checkouts');
      const cp = await val(db, `INSERT INTO coupons (code, title, type, value, usage_limit_total, updated_at) VALUES ('LAST1','x','FLAT',100,1,now()) RETURNING id`);
      const O = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }], reserve: false }));
      const others = await Promise.all(Array.from({ length: 10 }, (_, i) => tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }], reserve: false }))));
      const cr = await Promise.allSettled(others.map((o, i) => tx(db, (c) => c.query(`SELECT aq_reserve_coupon($1,$2,NULL,$3,NULL,100)`, [o.orderId, cp, `u${i}@x.in`]))));
      eq(cr.filter((x) => x.status === 'fulfilled').length, 1, 'final coupon use once');
      // per-customer limit for guests matches the citext email case-insensitively (citext = text would not)
      const per = await val(db, `INSERT INTO coupons (code, title, type, value, usage_limit_per_customer, updated_at) VALUES ('ONCE1','x','FLAT',100,1,now()) RETURNING id`);
      const [g1, g2] = await Promise.all([1, 2].map(() => tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 1 }], reserve: false }))));
      await tx(db, (c) => c.query(`SELECT aq_reserve_coupon($1,$2,NULL,'guest@x.in',NULL,100)`, [g1.orderId, per]));
      await rejects(tx(db, (c) => c.query(`SELECT aq_reserve_coupon($1,$2,NULL,'GUEST@X.IN',NULL,100)`, [g2.orderId, per])),
        /COUPON_USAGE_EXCEEDED:customer/, 'per-customer limit is case-insensitive');

      await db.query(`INSERT INTO invoices (order_id, kind, number, fy, seq, issued_at, seller_snapshot, buyer_snapshot, place_of_supply, lines,
                      taxable_total, cgst_total, sgst_total, igst_total, grand_total) VALUES ($1,'TAX_INVOICE','AQ/26-27/000001','26-27',1,now(),'{}','{}','32','[]',847,77,76,0,1000)`, [O.orderId]);
      await rejects(db.query(`UPDATE invoices SET grand_total=1`), /immutable/, 'invoice update');
      await rejects(db.query(`DELETE FROM invoices`), /immutable/, 'invoice delete');
      await rejects(db.query(`UPDATE order_items SET unit_price=1 WHERE order_id=$1`, [O.orderId]), /immutable/, 'snapshot');
      return `gate: "${m1.slice(0, 90)}…" → after tax/weight/count "${m2}" → PROCESSING image rejected → READY image publishes; post-publish media failure visible in published_not_ready; 12 checkouts on 5 units → 5; coupon limit 1 under 10 → 1; per-customer limit case-insensitive; invoice/order-item immutability enforced`;
    } finally { await db.end(); }
  },
};
