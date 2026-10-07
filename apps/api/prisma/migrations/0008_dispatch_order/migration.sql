-- GENERATED from docs/database.md §8.4 by scripts/db-from-docs.mjs. Do not edit.
-- 0008 (task 5.2): aq_dispatch_order, database.md §8.4 as one function. Ships a packed order: consumes its stock
-- reservations, issues the tax invoice with the next consecutive number of its financial year, records the shipment,
-- moves fulfilment PACKED → SHIPPED and emits the customer email and the invoice PDF job, all in one transaction.
-- The invoice content (seller/buyer snapshots, lines with HSN and CGST/SGST or IGST, totals) is computed by the API
-- with the shared tax rules and passed in; this function checks it adds up to the order total and stores it once
-- (invoices are immutable, trigger 0002). Lock order (§4.1): order → reservations → variants ↑ → products ↑ →
-- invoice counter. The counter row is incremented inside this transaction, so a failure anywhere rolls the number
-- back too: numbers are gap-free per (kind, fy). Additive (a new function).
CREATE OR REPLACE FUNCTION aq_dispatch_order(p_order INT, p_courier TEXT, p_awb TEXT, p_tracking_url TEXT, p_weight_g INT,
                                             p_invoice JSONB, p_notify BOOLEAN, p_actor INT)
RETURNS JSONB AS $$
DECLARE o RECORD; r RECORD; v RECORD; n INT; seq INT; inv_id INT; ship_id INT; inv_no TEXT; v_fy TEXT; lines_total BIGINT;
BEGIN
  SELECT id, order_number, status, payment_status, fulfilment_status, total INTO o FROM orders WHERE id = p_order FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND:order %', p_order USING ERRCODE = 'P0001'; END IF;
  IF o.status <> 'CONFIRMED' OR o.fulfilment_status <> 'PACKED' OR o.payment_status NOT IN ('PAID', 'COD_PENDING') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION:order % is %/%/%', p_order, o.status, o.fulfilment_status, o.payment_status USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM shipments WHERE courier_name = p_courier AND awb_number = p_awb) THEN
    RAISE EXCEPTION 'AWB_IN_USE:% %', p_courier, p_awb USING ERRCODE = 'P0001';
  END IF;

  -- The invoice must account for the whole order, and its lines for its totals.
  v_fy := p_invoice->>'fy';
  IF v_fy IS NULL OR v_fy !~ '^\d{2}-\d{2}$' THEN RAISE EXCEPTION 'INVOICE_INVALID:fy %', v_fy USING ERRCODE = 'P0001'; END IF;
  IF (p_invoice->>'grand_total')::BIGINT <> o.total THEN
    RAISE EXCEPTION 'INVOICE_INVALID:grand total % <> order total %', p_invoice->>'grand_total', o.total USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(sum((l->>'taxable')::BIGINT + (l->>'cgst')::BIGINT + (l->>'sgst')::BIGINT + (l->>'igst')::BIGINT), 0) INTO lines_total
    FROM jsonb_array_elements(p_invoice->'lines') l;
  IF lines_total + (p_invoice->>'rounding_adjustment')::BIGINT <> o.total
     OR (p_invoice->>'taxable_total')::BIGINT + (p_invoice->>'cgst_total')::BIGINT + (p_invoice->>'sgst_total')::BIGINT
        + (p_invoice->>'igst_total')::BIGINT + (p_invoice->>'rounding_adjustment')::BIGINT <> o.total THEN
    RAISE EXCEPTION 'INVOICE_INVALID:lines and totals do not add up to %', o.total USING ERRCODE = 'P0001';
  END IF;

  -- Every item must still hold its full reservation.
  IF EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = p_order
              AND oi.quantity <> coalesce((SELECT sum(quantity) FROM inventory_reservations x WHERE x.order_item_id = oi.id AND x.status = 'ACTIVE'), 0)) THEN
    RAISE EXCEPTION 'INVARIANT: order % has an item without its full active reservation', p_order;
  END IF;
  FOR r IN SELECT id, variant_id, quantity FROM inventory_reservations
            WHERE order_id = p_order AND status = 'ACTIVE' ORDER BY variant_id, id LOOP
    UPDATE product_variants SET on_hand = on_hand - r.quantity, reserved = reserved - r.quantity, version = version + 1 WHERE id = r.variant_id
    RETURNING on_hand, reserved INTO v;
    UPDATE inventory_reservations SET status = 'CONSUMED', consumed_at = now() WHERE id = r.id;
    INSERT INTO inventory_movements (variant_id, reason, on_hand_delta, reserved_delta, on_hand_after, reserved_after, order_id, reservation_id, actor_id)
    VALUES (r.variant_id, 'CONSUME', -r.quantity, -r.quantity, v.on_hand, v.reserved, p_order, r.id, p_actor);
  END LOOP;
  PERFORM aq_refresh_products(ARRAY(SELECT DISTINCT product_id FROM order_items WHERE order_id = p_order));

  INSERT INTO invoice_counters (kind, fy, last_no) VALUES ('TAX_INVOICE', v_fy, 1)
  ON CONFLICT (kind, fy) DO UPDATE SET last_no = invoice_counters.last_no + 1
  RETURNING last_no INTO seq;
  inv_no := 'AQ/' || v_fy || '/' || lpad(seq::TEXT, 6, '0');
  INSERT INTO invoices (order_id, kind, number, fy, seq, issued_at, seller_snapshot, buyer_snapshot, place_of_supply, lines,
                        taxable_total, cgst_total, sgst_total, igst_total, rounding_adjustment, grand_total, created_by)
  VALUES (p_order, 'TAX_INVOICE', inv_no, v_fy, seq, now(), p_invoice->'seller', p_invoice->'buyer', p_invoice->>'place_of_supply', p_invoice->'lines',
          (p_invoice->>'taxable_total')::INT, (p_invoice->>'cgst_total')::INT, (p_invoice->>'sgst_total')::INT, (p_invoice->>'igst_total')::INT,
          (p_invoice->>'rounding_adjustment')::INT, o.total, p_actor)
  RETURNING id INTO inv_id;

  INSERT INTO shipments (order_id, courier_name, awb_number, tracking_url, status, weight_g, shipped_at, updated_at)
  VALUES (p_order, p_courier, p_awb, p_tracking_url, 'SHIPPED', p_weight_g, now(), now())
  RETURNING id INTO ship_id;
  UPDATE orders SET fulfilment_status = 'SHIPPED', version = version + 1, updated_at = now() WHERE id = p_order AND fulfilment_status = 'PACKED';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'INVARIANT: order % could not transition to SHIPPED', p_order; END IF;
  INSERT INTO order_status_history (order_id, dimension, from_value, to_value, actor_type, actor_id) VALUES (p_order, 'FULFILMENT', 'PACKED', 'SHIPPED', 'ADMIN', p_actor);

  IF p_notify THEN
    PERFORM aq_emit('order', o.order_number, 'order.status_changed', jsonb_build_object('order_id', p_order, 'to', 'SHIPPED'), ARRAY['email.customer']);
  END IF;
  PERFORM aq_emit('invoice', inv_id::TEXT, 'invoice.render', jsonb_build_object('invoice_id', inv_id, 'order_id', p_order), ARRAY['invoice.render']);
  RETURN jsonb_build_object('invoice_id', inv_id, 'invoice_number', inv_no, 'shipment_id', ship_id);
END $$ LANGUAGE plpgsql;
