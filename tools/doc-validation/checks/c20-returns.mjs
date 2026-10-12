// Task 5.5: returns (database.md §8.5b, migration 0011). Concurrent or repeated requests never return more units than
// were delivered; decisions, receipt and inspection happen once; sellable units are restocked once, damaged ones only
// recorded; return refunds are bounded by the units received (approved for a missing item) even under concurrency;
// cancelling or rejecting releases the units; photos must be this order's unattached uploads.
import { pool, tx, catalog, order, attempt, apply, val, one, eq, rejects } from '../lib/db.mjs';

const items = (pairs, key = 'quantity') => JSON.stringify(pairs.map(([id, q]) => ({ order_item_id: id, [key]: q })));

export default {
  id: 'C20', title: 'Returns: quantities bounded under concurrency; steps once; restock once; return refunds bounded by units received',
  async run({ cfg }) {
    const db = pool(cfg, 60);
    try {
      const cat = await catalog(db, [[{ price: 1000, onHand: 100 }], [{ price: 3000, onHand: 100 }]]);
      const [v1, v2] = cat.products.map((p) => p.variantIds[0]);
      const stock = (v) => val(db, `SELECT on_hand FROM product_variants WHERE id = $1`, [v]);
      /** Prepaid and delivered (hours ago): 2 × ₹10 + 1 × ₹30, shipping ₹5. */
      const delivered = async (hoursAgo = 1) => {
        const o = await tx(db, (c) => order(c, { lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }], shippingFee: 500 }));
        const a = await tx(db, (c) => attempt(c, o.orderId, o.total));
        eq(await tx(db, (c) => apply(c, { providerOrderId: a.providerOrderId, paymentId: `pay_${o.orderId}`, amount: o.total })), 'APPLIED', 'paid');
        await db.query(`UPDATE orders SET status = 'CONFIRMED', fulfilment_status = 'DELIVERED' WHERE id = $1`, [o.orderId]);
        await db.query(`INSERT INTO shipments (order_id, courier_name, awb_number, status, shipped_at, delivered_at, updated_at)
                        VALUES ($1, 'DTDC', $2, 'DELIVERED', now() - interval '3 days', now() - make_interval(hours => $3), now())`, [o.orderId, `C20-${o.orderId}`, hoursAgo]);
        const [i1, i2] = (await db.query(`SELECT id FROM order_items WHERE order_id = $1 ORDER BY id`, [o.orderId])).rows.map((r) => r.id);
        const pay = await val(db, `SELECT id FROM payments WHERE order_id = $1`, [o.orderId]);
        return { ...o, i1, i2, pay };
      };
      const request = (c, o, its, reason = 'DAMAGED', media = []) => val(c, `SELECT aq_request_return($1, NULL, $2, NULL, $3::jsonb, $4::int[], 48)`, [o.orderId, reason, its, media]);
      const requested = (id) => val(db, `SELECT return_requested_qty FROM order_items WHERE id = $1`, [id]);

      // 8 concurrent requests for 1 unit of a 2-unit line: exactly 2 succeed.
      const o = await delivered();
      const race = await Promise.allSettled(Array.from({ length: 8 }, () => tx(db, (c) => request(c, o, items([[o.i1, 1]])))));
      eq(race.filter((x) => x.status === 'fulfilled').length, 2, 'two requests fit the two units');
      eq(race.filter((x) => x.status === 'rejected').every((x) => /RETURN_NOT_ALLOWED:quantity/.test(x.reason.message)), true, 'the rest: quantity');
      eq(await requested(o.i1), 2, 'requested = bought');
      eq(await val(db, `SELECT return_status::text FROM orders WHERE id = $1`, [o.orderId]), 'OPEN', 'order return OPEN');
      await rejects(tx(db, (c) => request(c, o, items([[o.i2, 2]]))), /RETURN_NOT_ALLOWED:quantity/, 'more than bought');
      await rejects(tx(db, (c) => request(c, o, JSON.stringify([{ order_item_id: o.i2, quantity: 1 }, { order_item_id: o.i2, quantity: 1 }]))), /RETURN_NOT_ALLOWED:items/, 'same item twice');
      await rejects(tx(db, (c) => request(c, o, items([[o.i2, 0]]))), /RETURN_NOT_ALLOWED:quantity/, 'zero units');
      eq(await val(db, `SELECT count(*)::int FROM return_requests WHERE order_id = $1`, [o.orderId]), 2, 'refusals leave no request');

      // Reject one: its unit is free again. Approve the other; concurrent decisions → one.
      const [ra, rb] = (await db.query(`SELECT id FROM return_requests WHERE order_id = $1 ORDER BY id`, [o.orderId])).rows.map((r) => r.id);
      await tx(db, (c) => c.query(`SELECT aq_decide_return($1, false, '[]'::jsonb, 'not damaged', NULL)`, [ra]));
      eq(await requested(o.i1), 1, 'rejected unit released');
      const dec = await Promise.allSettled(Array.from({ length: 4 }, () => tx(db, (c) => c.query(`SELECT aq_decide_return($1, true, $2::jsonb, NULL, NULL)`, [rb, items([[o.i1, 1]], 'approved_qty')]))));
      eq(dec.filter((x) => x.status === 'fulfilled').length, 1, 'one decision');
      eq(dec.filter((x) => x.status === 'rejected').every((x) => /INVALID_TRANSITION/.test(x.reason.message)), true, 'second decision refused');
      await rejects(tx(db, (c) => c.query(`SELECT aq_request_return_refund($1,$2,$3::jsonb,0,'r','k0',NULL)`, [rb, o.pay, JSON.stringify([{ order_item_id: o.i1, quantity: 1, amount: 1000 }])])), /INVALID_TRANSITION/, 'no refund before inspection');

      // Receive and inspect once; the sellable unit is restocked once.
      await tx(db, (c) => c.query(`SELECT aq_set_return_status($1, 'IN_TRANSIT', NULL, NULL)`, [rb]));
      await rejects(tx(db, (c) => c.query(`SELECT aq_receive_return($1, $2::jsonb, NULL)`, [rb, items([[o.i1, 2]], 'received_qty')])), /RETURN_NOT_ALLOWED:received/, 'more received than approved');
      await tx(db, (c) => c.query(`SELECT aq_receive_return($1, $2::jsonb, NULL)`, [rb, items([[o.i1, 1]], 'received_qty')]));
      await rejects(tx(db, (c) => c.query(`SELECT aq_inspect_return($1, $2::jsonb, NULL)`, [rb, JSON.stringify([{ order_item_id: o.i1, sellable_qty: 1, damaged_qty: 1 }])])), /RETURN_NOT_ALLOWED:inspection/, 'inspection must add up');
      const s1 = await stock(v1);
      const insp = await Promise.allSettled(Array.from({ length: 4 }, () => tx(db, (c) => c.query(`SELECT aq_inspect_return($1, $2::jsonb, NULL)`, [rb, JSON.stringify([{ order_item_id: o.i1, sellable_qty: 1, damaged_qty: 0 }])]))));
      eq(insp.filter((x) => x.status === 'fulfilled').length, 1, 'one inspection');
      eq(await stock(v1), s1 + 1, 'restocked once');
      eq(await val(db, `SELECT count(*)::int FROM inventory_movements WHERE return_request_id = $1 AND reason = 'RETURN_RESTOCK'`, [rb]), 1, 'one restock movement');
      eq(await one(db, `SELECT returned_qty, return_requested_qty FROM order_items WHERE id = $1`, [o.i1]), { returned_qty: 1, return_requested_qty: 1 }, 'returned 1');

      // Return refunds: concurrent refunds for the one received unit → one; above the unit's share → refused.
      await rejects(tx(db, (c) => c.query(`SELECT aq_request_return_refund($1,$2,$3::jsonb,0,'r','k1',NULL)`, [rb, o.pay, JSON.stringify([{ order_item_id: o.i1, quantity: 1, amount: 1001 }])])), /REFUND_EXCEEDS_CAPACITY:return/, 'more than one unit’s share');
      await rejects(tx(db, (c) => c.query(`SELECT aq_request_return_refund($1,$2,$3::jsonb,0,'r','k2',NULL)`, [rb, o.pay, JSON.stringify([{ order_item_id: o.i2, quantity: 1, amount: 100 }])])), /RETURN_NOT_ALLOWED:item/, 'an item not in the return');
      const rr = await Promise.allSettled(Array.from({ length: 5 }, (_, n) => tx(db, (c) => c.query(`SELECT aq_request_return_refund($1,$2,$3::jsonb,500,'r',$4,NULL) AS r`,
        [rb, o.pay, JSON.stringify([{ order_item_id: o.i1, quantity: 1, amount: 1000 }]), `rr-${n}`]))));
      eq(rr.filter((x) => x.status === 'fulfilled').length, 1, 'one return refund');
      eq(rr.filter((x) => x.status === 'rejected').every((x) => /REFUND_EXCEEDS_CAPACITY/.test(x.reason.message)), true, 'the rest exceed capacity');
      eq(await one(db, `SELECT kind::text, amount, shipping_amount, return_request_id FROM refunds WHERE order_id = $1`, [o.orderId]),
        { kind: 'RETURN', amount: 1500, shipping_amount: 500, return_request_id: rb }, 'linked RETURN refund with shipping');
      eq(await val(db, `SELECT status::text FROM return_requests WHERE id = $1`, [rb]), 'REFUNDED', 'return REFUNDED');
      // A failed refund frees the return's unit for a new refund.
      await db.query(`UPDATE refunds SET status = 'FAILED' WHERE order_id = $1`, [o.orderId]);
      await db.query(`SELECT aq_refund_capacity(id, -1) FROM refunds WHERE order_id = $1`, [o.orderId]);
      await tx(db, (c) => c.query(`SELECT aq_request_return_refund($1,$2,$3::jsonb,0,'again','rr-again',NULL)`, [rb, o.pay, JSON.stringify([{ order_item_id: o.i1, quantity: 1, amount: 1000 }])]));
      await tx(db, (c) => c.query(`SELECT aq_set_return_status($1, 'CLOSED', 'done', NULL)`, [rb]));
      eq(await val(db, `SELECT return_status::text FROM orders WHERE id = $1`, [o.orderId]), 'CLOSED', 'order return CLOSED');
      await rejects(tx(db, (c) => c.query(`SELECT aq_set_return_status($1, 'CANCELLED', NULL, NULL)`, [rb])), /INVALID_TRANSITION/, 'closed cannot be cancelled');

      // Missing item: approved and refunded without coming back; nothing restocked.
      const m = await delivered();
      const mr = await tx(db, (c) => request(c, m, items([[m.i2, 1]]), 'MISSING_ITEM'));
      await tx(db, (c) => c.query(`SELECT aq_decide_return($1, true, $2::jsonb, NULL, NULL)`, [mr, items([[m.i2, 1]], 'approved_qty')]));
      await rejects(tx(db, (c) => c.query(`SELECT aq_receive_return($1, $2::jsonb, NULL)`, [mr, items([[m.i2, 1]], 'received_qty')])), /RETURN_NOT_ALLOWED:missing_item/, 'missing items are not received');
      const s2 = await stock(v2);
      await tx(db, (c) => c.query(`SELECT aq_request_return_refund($1,$2,$3::jsonb,0,'missing','m-1',NULL)`, [mr, m.pay, JSON.stringify([{ order_item_id: m.i2, quantity: 1, amount: 3000 }])]));
      eq(await stock(v2), s2, 'nothing restocked');
      await tx(db, (c) => c.query(`SELECT aq_set_return_status($1, 'CLOSED', NULL, NULL)`, [mr]));

      // Cancel before receipt releases the units; window and delivery are enforced; photos must belong to the order.
      const k = await delivered();
      const kr = await tx(db, (c) => request(c, k, items([[k.i1, 2]])));
      await tx(db, (c) => c.query(`SELECT aq_decide_return($1, true, $2::jsonb, NULL, NULL)`, [kr, items([[k.i1, 1]], 'approved_qty')]));
      eq(await requested(k.i1), 1, 'unapproved unit released');
      await tx(db, (c) => c.query(`SELECT aq_set_return_status($1, 'CANCELLED', 'customer kept it', NULL)`, [kr]));
      eq(await requested(k.i1), 0, 'cancel releases the approved unit');
      const late = await delivered(49);
      await rejects(tx(db, (c) => request(c, late, items([[late.i1, 1]]))), /RETURN_NOT_ALLOWED:window/, 'outside the 48 h window');
      const notYet = await delivered();
      await db.query(`UPDATE orders SET fulfilment_status = 'SHIPPED' WHERE id = $1`, [notYet.orderId]);
      await rejects(tx(db, (c) => request(c, notYet, items([[notYet.i1, 1]]))), /RETURN_NOT_ALLOWED:state/, 'not delivered');
      const ph = await delivered();
      const photo = (scope, status = 'READY') => val(db, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, updated_at)
        VALUES (gen_random_uuid()::text, 'PRIVATE', 'IMAGE', 'image/jpeg', 10, $1, $2, now()) RETURNING id`, [scope, status]);
      const good = await photo(`return:${ph.orderId}`);
      const foreign = await photo(`return:${o.orderId}`), processing = await photo(`return:${ph.orderId}`, 'PROCESSING');
      await rejects(tx(db, (c) => request(c, ph, items([[ph.i1, 1]]), 'DAMAGED', [good, foreign])), /RETURN_NOT_ALLOWED:media/, 'another order’s photo');
      await rejects(tx(db, (c) => request(c, ph, items([[ph.i1, 1]]), 'DAMAGED', [processing])), /RETURN_NOT_ALLOWED:media/, 'photo not processed yet');
      const pr = await tx(db, (c) => request(c, ph, items([[ph.i1, 1]]), 'DAMAGED', [good, good]));
      eq(await val(db, `SELECT count(*)::int FROM return_request_media WHERE return_request_id = $1`, [pr]), 1, 'photo attached once');
      await rejects(tx(db, (c) => request(c, ph, items([[ph.i1, 1]]), 'DAMAGED', [good])), /RETURN_NOT_ALLOWED:media/, 'a photo attaches to one request only');
      eq(await val(db, `SELECT count(*)::int FROM outbox_events WHERE event_type = 'return.status_changed'`) > 0, true, 'customer emails queued');
      return '8 concurrent requests for a 2-unit line → 2; excess, duplicate and zero quantities refused; reject/cancel/partial approval release units; decision ×4 → 1; inspection ×4 → 1 (restocked once); return refunds ×5 for one received unit → 1 (above the unit share refused; failed refund frees it); missing item refunded without receipt or restock; window, delivery and photo ownership enforced';
    } finally { await db.end(); }
  },
};
