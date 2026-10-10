// Task 5.2: aq_dispatch_order (database.md §8.4, migration 0008). Invoice numbers are consecutive and gap-free per
// financial year under concurrent dispatches, including when some dispatches fail; one order ships once; stock is
// consumed exactly once; refusals (not packed, AWB in use, totals that do not add up) leave no trace.
import { pool, tx, catalog, order, val, one, eq, rejects } from '../lib/db.mjs';

/** A one-line invoice for an order total (CGST/SGST split; the API computes real lines with the shared tax rules). */
const invoice = (total, fy = '26-27', o = {}) => {
  const tax = Math.round(total * 18 / 118), cgst = Math.floor(tax / 2);
  return { fy, seller: { name: 'ArtQ' }, buyer: { name: 'A' }, place_of_supply: '32', lines: [{ kind: 'ITEM', taxable: total - tax, cgst, sgst: tax - cgst, igst: 0 }],
    taxable_total: total - tax, cgst_total: cgst, sgst_total: tax - cgst, igst_total: 0, rounding_adjustment: 0, grand_total: total, ...o };
};
const dispatch = (c, id, total, awb, o = {}) => c.query(`SELECT aq_dispatch_order($1, 'DTDC', $2, NULL, 500, $3::jsonb, $4, 1) AS r`,
  [id, awb, JSON.stringify(o.invoice ?? invoice(total, o.fy)), o.notify ?? true]).then((r) => r.rows[0].r);

export default {
  id: 'C17', title: 'Dispatch: gap-free invoice numbers under 20 concurrent dispatches; ships and consumes stock once; refusals leave no trace',
  async run({ cfg }) {
    const db = pool(cfg, 60);
    try {
      await db.query(`INSERT INTO users (email, role, status, updated_at) VALUES ('ops@artq.in','ADMIN','ACTIVE',now())`);
      const cat = await catalog(db, [[{ price: 1000, onHand: 200 }], [{ price: 2500, onHand: 200 }]]);
      const [v1, v2] = cat.products.map((p) => p.variantIds[0]);
      const packed = async (lines = [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }]) => {
        const o = await tx(db, (c) => order(c, { lines, method: 'COD', status: 'CONFIRMED', paymentStatus: 'COD_PENDING' }));
        await db.query(`UPDATE orders SET fulfilment_status = 'PACKED' WHERE id = $1`, [o.orderId]);
        return o;
      };
      const stock = async (v) => one(db, `SELECT on_hand, reserved FROM product_variants WHERE id = $1`, [v]);

      // 20 orders dispatched at once, with 5 invalid dispatches racing among them: numbers 1..20, no gaps, no duplicates.
      const orders = await Promise.all(Array.from({ length: 20 }, () => packed()));
      const bad = await Promise.all(Array.from({ length: 5 }, () => packed()));
      const before = await stock(v1);
      const runs = [
        ...orders.map((o, i) => tx(db, (c) => dispatch(c, o.orderId, o.total, `A${i}`))),
        ...bad.map((o, i) => tx(db, (c) => dispatch(c, o.orderId, o.total, `B${i}`, { invoice: invoice(o.total + 1) }))),
      ];
      const st = await Promise.allSettled(runs);
      const failed = st.slice(0, 20).filter((x) => x.status === 'rejected').map((x) => x.reason.message);
      eq([...new Set(failed)], [], 'all valid dispatches succeed');
      eq(st.slice(20).every((x) => x.status === 'rejected' && /INVOICE_INVALID/.test(x.reason.message)), true, 'mismatched totals refused');
      const seqs = (await db.query(`SELECT seq, number FROM invoices WHERE fy = '26-27' ORDER BY seq`)).rows;
      eq(seqs.map((r) => r.seq), Array.from({ length: 20 }, (_, i) => i + 1), 'consecutive 1..20');
      eq(seqs[0].number, 'AQ/26-27/000001', 'number format');
      eq(await val(db, `SELECT last_no FROM invoice_counters WHERE kind = 'TAX_INVOICE' AND fy = '26-27'`), 20, 'refused dispatches did not advance the counter');
      const after = await stock(v1);
      eq([before.on_hand - after.on_hand, before.reserved - after.reserved], [40, 40], 'v1: 20 orders × 2 consumed from on hand and reserved');
      eq(await val(db, `SELECT count(*)::int FROM inventory_movements WHERE reason = 'CONSUME'`), 40, 'one CONSUME movement per reservation');
      eq(await val(db, `SELECT count(*)::int FROM inventory_reservations WHERE order_id = ANY($1) AND status = 'ACTIVE'`, [bad.map((o) => o.orderId)]), 10, 'refused orders keep their reservations');
      eq(await val(db, `SELECT count(*)::int FROM orders WHERE id = ANY($1) AND fulfilment_status = 'SHIPPED'`, [orders.map((o) => o.orderId)]), 20, 'shipped');
      eq(await val(db, `SELECT count(*)::int FROM outbox_events WHERE event_type = 'invoice.render'`), 20, 'one PDF job per invoice');

      // One order pressed 6 times at once: ships once, consumes once.
      const one1 = await packed([{ variantId: v2, qty: 3 }]);
      const s2 = await stock(v2);
      const race = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => tx(db, (c) => dispatch(c, one1.orderId, one1.total, `R${i}`))));
      eq(race.filter((x) => x.status === 'fulfilled').length, 1, 'one dispatch wins');
      eq(race.filter((x) => x.status === 'rejected').every((x) => /INVALID_TRANSITION/.test(x.reason.message)), true, 'others: INVALID_TRANSITION');
      const s2b = await stock(v2);
      eq([s2.on_hand - s2b.on_hand, s2.reserved - s2b.reserved], [3, 3], 'consumed once');
      eq(await val(db, `SELECT last_no FROM invoice_counters WHERE fy = '26-27'`), 21, 'one more number');

      // Refusals leave no trace: not packed, AWB already used by this courier, a new financial year starts at 1.
      const unpacked = await tx(db, (c) => order(c, { lines: [{ variantId: v1, qty: 1 }], method: 'COD', status: 'CONFIRMED', paymentStatus: 'COD_PENDING' }));
      await rejects(tx(db, (c) => dispatch(c, unpacked.orderId, unpacked.total, 'U1')), /INVALID_TRANSITION/, 'not packed');
      const dup = await packed();
      await rejects(tx(db, (c) => dispatch(c, dup.orderId, dup.total, 'A0')), /AWB_IN_USE/, 'AWB reused');
      eq(await val(db, `SELECT fulfilment_status::text FROM orders WHERE id = $1`, [dup.orderId]), 'PACKED', 'still packed');
      eq(await val(db, `SELECT last_no FROM invoice_counters WHERE fy = '26-27'`), 21, 'counter unchanged by refusals');
      const r = await tx(db, (c) => dispatch(c, dup.orderId, dup.total, 'NEWFY', { fy: '27-28', notify: false }));
      eq(r.invoice_number, 'AQ/27-28/000001', 'a new financial year starts its own series');
      eq(await val(db, `SELECT count(*)::int FROM outbox_events WHERE event_type = 'order.status_changed' AND payload->>'order_id' = $1`, [String(dup.orderId)]), 0, 'no email when not notifying');
      await rejects(db.query(`UPDATE invoices SET grand_total = 1 WHERE id = $1`, [r.invoice_id]), /immutable/, 'issued invoice is immutable');
      return '20 concurrent dispatches + 5 refused (bad totals) → numbers 1..20, counter 20; stock consumed once per reservation (40 movements); same order ×6 → 1 ships, consumed once; not packed / reused AWB refused without advancing the counter; new FY → 000001; invoice immutable';
    } finally { await db.end(); }
  },
};
