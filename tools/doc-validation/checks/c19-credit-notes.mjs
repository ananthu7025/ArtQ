// Task 5.4: aq_issue_credit_note (database.md §8.5a, migration 0010). Credit-note numbers are gap-free under
// concurrency; one credit note per refund even when issued concurrently; orders never invoiced and refunds with no
// order part are skipped; unprocessed refunds, totals that do not add up and a different place of supply are refused
// without using a number.
import { pool, tx, catalog, order, attempt, apply, val, eq, rejects } from '../lib/db.mjs';

const content = (amount, o = {}) => {
  const tax = Math.round(amount * 18 / 118), cgst = Math.floor(tax / 2);
  return { fy: '26-27', seller: {}, buyer: {}, place_of_supply: '32', lines: [{ kind: 'ITEM', taxable: amount - tax, cgst, sgst: tax - cgst, igst: 0 }],
    taxable_total: amount - tax, cgst_total: cgst, sgst_total: tax - cgst, igst_total: 0, rounding_adjustment: 0, grand_total: amount, ...o };
};
const issue = (c, rid, body) => c.query(`SELECT aq_issue_credit_note($1, $2::jsonb, NULL) AS r`, [rid, JSON.stringify(body)]).then((r) => r.rows[0].r);

export default {
  id: 'C19', title: 'Credit notes: gap-free numbers under concurrency; one per refund; skipped when not invoiced; refusals use no number',
  async run({ cfg }) {
    const db = pool(cfg, 60);
    try {
      const cat = await catalog(db, [[{ price: 1000, onHand: 500 }]]);
      const v = cat.products[0].variantIds[0];
      /** A paid order, optionally shipped with a tax invoice, and one processed goodwill refund of ₹3 on its item. */
      const refunded = async (invoiced = true, amount = 300) => {
        const o = await tx(db, (c) => order(c, { lines: [{ variantId: v, qty: 2 }] }));
        const a = await tx(db, (c) => attempt(c, o.orderId, o.total));
        await tx(db, (c) => apply(c, { providerOrderId: a.providerOrderId, paymentId: `pay_${o.orderId}`, amount: o.total }));
        if (invoiced) {
          await db.query(`UPDATE orders SET status = 'CONFIRMED', fulfilment_status = 'PACKED' WHERE id = $1`, [o.orderId]);
          const t = o.total, tax = Math.round(t * 18 / 118), cgst = Math.floor(tax / 2);
          await tx(db, (c) => c.query(`SELECT aq_dispatch_order($1,'DTDC',$2,NULL,NULL,$3::jsonb,false,NULL)`, [o.orderId, `C19-${o.orderId}`,
            JSON.stringify({ fy: '26-27', seller: {}, buyer: {}, place_of_supply: '32', lines: [{ kind: 'ITEM', taxable: t - tax, cgst, sgst: tax - cgst, igst: 0 }], taxable_total: t - tax, cgst_total: cgst, sgst_total: tax - cgst, igst_total: 0, rounding_adjustment: 0, grand_total: t })]));
        }
        const pay = await val(db, `SELECT id FROM payments WHERE order_id = $1`, [o.orderId]);
        const item = await val(db, `SELECT id FROM order_items WHERE order_id = $1`, [o.orderId]);
        const rid = await tx(db, (c) => val(c, `SELECT aq_request_refund($1,$2,'GOODWILL',$3::jsonb,0,0,0,'r','gw',NULL)`, [o.orderId, pay, JSON.stringify([{ order_item_id: item, quantity: 0, amount }])]));
        return { o, rid, process: () => tx(db, (c) => c.query(`SELECT aq_mark_refund_processed($1, NULL)`, [rid])) };
      };

      // Not processed yet → refused, no number used.
      const early = await refunded();
      await rejects(tx(db, (c) => issue(c, early.rid, content(300))), /INVALID_TRANSITION/, 'unprocessed refund');
      await early.process();

      // 10 refunds of 10 orders issued at once (plus the early one): numbers 1..11, no gaps.
      const many = await Promise.all(Array.from({ length: 10 }, () => refunded()));
      for (const m of many) await m.process();
      const all = [early, ...many];
      const st = await Promise.allSettled(all.map((m) => tx(db, (c) => issue(c, m.rid, content(300)))));
      eq(st.filter((x) => x.status === 'rejected').map((x) => x.reason.message), [], 'all issued');
      const seqs = (await db.query(`SELECT seq FROM invoices WHERE kind = 'CREDIT_NOTE' ORDER BY seq`)).rows.map((r) => r.seq);
      eq(seqs, Array.from({ length: 11 }, (_, i) => i + 1), 'credit notes 1..11');
      eq(await val(db, `SELECT number FROM invoices WHERE kind = 'CREDIT_NOTE' AND seq = 1`), 'CN/26-27/000001', 'format');
      eq(await val(db, `SELECT count(*)::int FROM invoices i JOIN invoices o ON o.id = i.original_invoice_id WHERE i.kind = 'CREDIT_NOTE' AND o.kind = 'TAX_INVOICE'`), 11, 'each references its invoice');

      // The same refund issued 5 times at once: one credit note, the rest DUPLICATE.
      const dup = await refunded();
      await dup.process();
      const five = await Promise.all(Array.from({ length: 5 }, () => tx(db, (c) => issue(c, dup.rid, content(300)))));
      eq(five.map((r) => r.status).sort(), ['DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'ISSUED'], 'one per refund');
      eq(new Set(five.map((r) => r.number)).size, 1, 'same number returned');

      // Refused without using a number: totals that do not add up, another place of supply.
      const bad = await refunded();
      await bad.process();
      const last = await val(db, `SELECT last_no FROM invoice_counters WHERE kind = 'CREDIT_NOTE' AND fy = '26-27'`);
      await rejects(tx(db, (c) => issue(c, bad.rid, content(299))), /INVOICE_INVALID/, 'wrong total');
      await rejects(tx(db, (c) => issue(c, bad.rid, content(300, { place_of_supply: '29' }))), /INVOICE_INVALID/, 'place of supply');
      eq(await val(db, `SELECT last_no FROM invoice_counters WHERE kind = 'CREDIT_NOTE' AND fy = '26-27'`), last, 'no number used by refusals');
      eq((await tx(db, (c) => issue(c, bad.rid, content(300)))).number, `CN/26-27/${String(last + 1).padStart(6, '0')}`, 'next number');

      // Never invoiced (refund before dispatch) → skipped; immutable once issued.
      const pre = await refunded(false);
      await pre.process();
      eq((await tx(db, (c) => issue(c, pre.rid, content(300)))).status, 'SKIPPED', 'not invoiced');
      await rejects(db.query(`UPDATE invoices SET grand_total = 1 WHERE kind = 'CREDIT_NOTE'`), /immutable/, 'credit note immutable');
      return `unprocessed refused; 11 concurrent → CN 1..11 each against its invoice; same refund ×5 → 1 ISSUED + 4 DUPLICATE; bad total / other place of supply refused without a number, next is ${last + 1}; not invoiced → SKIPPED; immutable`;
    } finally { await db.end(); }
  },
};
