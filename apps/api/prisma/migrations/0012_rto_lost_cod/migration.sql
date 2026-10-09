-- GENERATED from docs/database.md §8.4a by scripts/db-from-docs.mjs. Do not edit.
-- 0012 (task 5.6): RTO received, lost parcels and COD remittances, database.md §8.4a. Additive (new functions).

-- Shared by RTO-received and lost-with-refund: the order is cancelled after it shipped. Prepaid → one CANCELLATION refund
-- of what is still refundable on the applied payment (items, and shipping when p_shipping); COD → NOT_COLLECTED. The
-- caller holds the order lock and has checked the state; it then locks variants, and calls aq_shipped_order_released
-- (products, coupon), keeping the global lock order. Returns the refund id.
CREATE OR REPLACE FUNCTION aq_cancel_shipped_order(p_order INT, p_reason TEXT, p_key TEXT, p_shipping BOOLEAN, p_actor INT) RETURNS INT AS $$
DECLARE o RECORD; pay RECORD; it RECORD; v_items JSONB; v_ship INT; rid INT; v_pay TEXT;
BEGIN
  SELECT id, status, payment_status, payment_method, shipping_fee, refund_reserved_shipping INTO o FROM orders WHERE id = p_order;
  v_pay := CASE WHEN o.payment_status = 'COD_PENDING' THEN 'NOT_COLLECTED' ELSE o.payment_status::TEXT END;
  UPDATE orders SET status = 'CANCELLED', payment_status = v_pay::"OrderPaymentStatus", cancelled_at = now(), cancel_reason = p_reason,
         cancelled_by = 'ADMIN', version = version + 1, updated_at = now()
   WHERE id = p_order;
  INSERT INTO order_status_history (order_id, dimension, from_value, to_value, actor_type, actor_id, note)
  VALUES (p_order, 'ORDER', o.status, 'CANCELLED', 'ADMIN', p_actor, p_reason);
  IF v_pay <> o.payment_status::TEXT THEN
    INSERT INTO order_status_history (order_id, dimension, from_value, to_value, actor_type, actor_id)
    VALUES (p_order, 'PAYMENT', o.payment_status, v_pay, 'ADMIN', p_actor);
  END IF;
  IF o.payment_method = 'RAZORPAY' AND o.payment_status IN ('PAID', 'PARTIALLY_REFUNDED') THEN
    SELECT id INTO pay FROM payments WHERE order_id = p_order AND allocation = 'APPLIED' ORDER BY id LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVARIANT: paid order % has no applied payment', p_order; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('order_item_id', id, 'quantity', quantity - refund_reserved_qty,
             'amount', net_amount - refund_reserved_amount,
             'tax_amount', CASE WHEN net_amount = 0 THEN 0 ELSE round(tax_amount::NUMERIC * (net_amount - refund_reserved_amount) / net_amount)::INT END)
             ORDER BY id), '[]'::JSONB)
      INTO v_items FROM order_items WHERE order_id = p_order AND net_amount - refund_reserved_amount > 0;
    v_ship := CASE WHEN p_shipping THEN o.shipping_fee - o.refund_reserved_shipping ELSE 0 END;
    IF jsonb_array_length(v_items) > 0 OR v_ship > 0 THEN
      rid := aq_request_refund(p_order, pay.id, 'CANCELLATION', v_items, v_ship, 0, 0, p_reason, p_key, p_actor);
    END IF;
  END IF;
  RETURN rid;
END $$ LANGUAGE plpgsql;

-- After the variants: sold counts down and aggregates refreshed (products ascending), then the coupon use reversed (D-14).
CREATE OR REPLACE FUNCTION aq_shipped_order_released(p_order INT) RETURNS void AS $$
DECLARE it RECORD;
BEGIN
  FOR it IN SELECT product_id, sum(quantity)::INT AS q FROM order_items WHERE order_id = p_order AND product_id IS NOT NULL
             GROUP BY product_id ORDER BY product_id LOOP
    UPDATE products SET sold_count = greatest(sold_count - it.q, 0) WHERE id = it.product_id;
  END LOOP;
  PERFORM aq_refresh_products(ARRAY(SELECT DISTINCT product_id FROM order_items WHERE order_id = p_order));
  PERFORM aq_reverse_coupon(p_order);
END $$ LANGUAGE plpgsql;

-- The RTO parcel is back. p_items = [{"order_item_id":1,"sellable_qty":1,"damaged_qty":1}], every line, adding up to its quantity.
CREATE OR REPLACE FUNCTION aq_receive_rto(p_order INT, p_items JSONB, p_notify BOOLEAN, p_actor INT) RETURNS JSONB AS $$
DECLARE o RECORD; it RECORD; v RECORD; was_available INT; n INT; rid INT; v_damaged INT;
BEGIN
  SELECT id, order_number, status, payment_status, fulfilment_status INTO o FROM orders WHERE id = p_order FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND:order %', p_order USING ERRCODE = 'P0001'; END IF;
  IF o.status <> 'CONFIRMED' OR o.fulfilment_status <> 'RTO_IN_TRANSIT' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION:order % is %/%', p_order, o.status, o.fulfilment_status USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR (SELECT count(DISTINCT x->>'order_item_id') FROM jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'RTO_INSPECTION_INVALID:items' USING ERRCODE = 'P0001';
  END IF;
  FOR it IN SELECT oi.id, oi.quantity, (x->>'sellable_qty')::INT AS s, (x->>'damaged_qty')::INT AS d
              FROM order_items oi LEFT JOIN jsonb_array_elements(p_items) x ON (x->>'order_item_id')::INT = oi.id
             WHERE oi.order_id = p_order ORDER BY oi.id LOOP
    IF it.s IS NULL OR it.d IS NULL OR it.s < 0 OR it.d < 0 OR it.s + it.d <> it.quantity THEN
      RAISE EXCEPTION 'RTO_INSPECTION_INVALID:%', it.id USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM jsonb_array_elements(p_items) x WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE id = (x->>'order_item_id')::INT AND order_id = p_order);
  IF n > 0 THEN RAISE EXCEPTION 'RTO_INSPECTION_INVALID:items' USING ERRCODE = 'P0001'; END IF;

  UPDATE orders SET fulfilment_status = 'RTO_RECEIVED', version = version + 1, updated_at = now() WHERE id = p_order;
  UPDATE shipments SET status = 'RTO_RECEIVED', rto_received_at = now(), updated_at = now() WHERE order_id = p_order;
  SELECT coalesce(sum((x->>'damaged_qty')::INT), 0) INTO v_damaged FROM jsonb_array_elements(p_items) x;
  INSERT INTO order_status_history (order_id, dimension, from_value, to_value, actor_type, actor_id, note)
  VALUES (p_order, 'FULFILMENT', 'RTO_IN_TRANSIT', 'RTO_RECEIVED', 'ADMIN', p_actor,
          CASE WHEN v_damaged > 0 THEN v_damaged || ' damaged unit(s) not restocked' END);
  rid := aq_cancel_shipped_order(p_order, 'Returned to us undelivered (RTO)', 'rto-' || p_order, FALSE, p_actor);

  -- Stock (after the payment): variants ascending, then products and coupon.
  FOR it IN SELECT oi.variant_id, sum((x->>'sellable_qty')::INT)::INT AS s
              FROM jsonb_array_elements(p_items) x JOIN order_items oi ON oi.id = (x->>'order_item_id')::INT
             WHERE oi.variant_id IS NOT NULL GROUP BY oi.variant_id HAVING sum((x->>'sellable_qty')::INT) > 0 ORDER BY oi.variant_id LOOP
    SELECT on_hand, reserved INTO v FROM product_variants WHERE id = it.variant_id FOR NO KEY UPDATE;
    was_available := v.on_hand - v.reserved;
    UPDATE product_variants SET on_hand = on_hand + it.s, version = version + 1 WHERE id = it.variant_id RETURNING on_hand, reserved INTO v;
    INSERT INTO inventory_movements (variant_id, reason, on_hand_delta, reserved_delta, on_hand_after, reserved_after, order_id, actor_id)
    VALUES (it.variant_id, 'RTO_RESTOCK', it.s, 0, v.on_hand, v.reserved, p_order, p_actor);
    IF was_available <= 0 AND v.on_hand - v.reserved > 0 THEN
      PERFORM aq_emit('variant', it.variant_id::TEXT, 'variant.back_in_stock', jsonb_build_object('variant_id', it.variant_id), ARRAY['restock.notify']);
    END IF;
  END LOOP;
  PERFORM aq_shipped_order_released(p_order);
  IF p_notify THEN
    PERFORM aq_emit('order', o.order_number, 'order.cancelled', jsonb_build_object('order_id', p_order, 'refund_id', rid, 'reason', 'RTO'), ARRAY['email.customer']);
  END IF;
  RETURN jsonb_build_object('refund_id', rid);
END $$ LANGUAGE plpgsql;

-- The courier lost the parcel. p_resolution REFUND (cancel + full refund) or RESHIP (a replacement as a new order).
CREATE OR REPLACE FUNCTION aq_mark_lost(p_order INT, p_resolution TEXT, p_note TEXT, p_notify BOOLEAN, p_actor INT) RETURNS JSONB AS $$
DECLARE o RECORD; it RECORD; v RECORD; rid INT;
BEGIN
  IF p_resolution NOT IN ('REFUND', 'RESHIP') THEN RAISE EXCEPTION 'bad resolution %', p_resolution; END IF;
  SELECT id, order_number, status, payment_status, fulfilment_status INTO o FROM orders WHERE id = p_order FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND:order %', p_order USING ERRCODE = 'P0001'; END IF;
  IF o.status <> 'CONFIRMED' OR o.fulfilment_status NOT IN ('SHIPPED', 'OUT_FOR_DELIVERY', 'RTO_IN_TRANSIT') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION:order % is %/%', p_order, o.status, o.fulfilment_status USING ERRCODE = 'P0001';
  END IF;
  UPDATE orders SET fulfilment_status = 'LOST', version = version + 1, updated_at = now() WHERE id = p_order;
  UPDATE shipments SET status = 'LOST', lost_at = now(), updated_at = now() WHERE order_id = p_order;
  INSERT INTO order_status_history (order_id, dimension, from_value, to_value, actor_type, actor_id, note)
  VALUES (p_order, 'FULFILMENT', o.fulfilment_status, 'LOST', 'ADMIN', p_actor, p_note);
  IF p_resolution = 'REFUND' THEN
    rid := aq_cancel_shipped_order(p_order, coalesce(p_note, 'Lost in transit'), 'lost-' || p_order, TRUE, p_actor);
  ELSIF o.payment_status = 'COD_PENDING' THEN
    UPDATE orders SET payment_status = 'NOT_COLLECTED', version = version + 1, updated_at = now() WHERE id = p_order;
    INSERT INTO order_status_history (order_id, dimension, from_value, to_value, actor_type, actor_id)
    VALUES (p_order, 'PAYMENT', 'COD_PENDING', 'NOT_COLLECTED', 'ADMIN', p_actor);
  END IF;
  -- Variants ascending (after the payment): an audit movement each, no stock change (the stock left at dispatch).
  FOR it IN SELECT variant_id, sum(quantity)::INT AS q FROM order_items WHERE order_id = p_order AND variant_id IS NOT NULL
             GROUP BY variant_id ORDER BY variant_id LOOP
    SELECT on_hand, reserved INTO v FROM product_variants WHERE id = it.variant_id FOR NO KEY UPDATE;
    INSERT INTO inventory_movements (variant_id, reason, on_hand_delta, reserved_delta, on_hand_after, reserved_after, order_id, note, actor_id)
    VALUES (it.variant_id, 'LOST_WRITE_OFF', 0, 0, v.on_hand, v.reserved, p_order, it.q || ' unit(s) lost in transit', p_actor);
  END LOOP;
  IF p_resolution = 'REFUND' THEN PERFORM aq_shipped_order_released(p_order); END IF;
  IF p_notify THEN
    PERFORM aq_emit('order', o.order_number, 'order.lost', jsonb_build_object('order_id', p_order, 'refund_id', rid, 'resolution', p_resolution), ARRAY['email.customer']);
  END IF;
  RETURN jsonb_build_object('refund_id', rid);
END $$ LANGUAGE plpgsql;

-- One courier COD payout. p_items = [{"order_id":1,"amount":110800}] (amounts as the courier paid them).
-- Returns {"remittance_id", "mismatches":[{"order_id","expected","remitted"}]}.
CREATE OR REPLACE FUNCTION aq_record_cod_remittance(p_courier TEXT, p_reference TEXT, p_remitted_at TIMESTAMPTZ, p_amount INT, p_note TEXT,
  p_items JSONB, p_actor INT) RETURNS JSONB AS $$
DECLARE it RECORD; o RECORD; rid INT; v_mis JSONB := '[]'::JSONB; v_sum BIGINT;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0
     OR (SELECT count(DISTINCT x->>'order_id') FROM jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'COD_REMITTANCE_INVALID:orders' USING ERRCODE = 'P0001';
  END IF;
  SELECT sum((x->>'amount')::BIGINT) INTO v_sum FROM jsonb_array_elements(p_items) x;
  IF p_amount IS NULL OR p_amount <= 0 OR v_sum IS DISTINCT FROM p_amount::BIGINT
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) x WHERE (x->>'amount')::INT IS NULL OR (x->>'amount')::INT <= 0) THEN
    RAISE EXCEPTION 'COD_REMITTANCE_INVALID:total' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM cod_remittances WHERE courier_name = p_courier AND reference = p_reference) THEN
    RAISE EXCEPTION 'COD_REMITTANCE_INVALID:reference' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO cod_remittances (courier_name, reference, amount, remitted_at, note, recorded_by)
  VALUES (p_courier, p_reference, p_amount, p_remitted_at, p_note, p_actor) RETURNING id INTO rid;
  FOR it IN SELECT (x->>'order_id')::INT AS order_id, (x->>'amount')::INT AS amount FROM jsonb_array_elements(p_items) x ORDER BY 1 LOOP
    SELECT id, total, payment_method, payment_status, fulfilment_status INTO o FROM orders WHERE id = it.order_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND:order %', it.order_id USING ERRCODE = 'P0001'; END IF;
    IF o.payment_method <> 'COD' OR o.fulfilment_status <> 'DELIVERED'
       OR o.payment_status NOT IN ('COD_COLLECTED', 'PARTIALLY_REFUNDED', 'REFUNDED')
       OR EXISTS (SELECT 1 FROM cod_remittance_items WHERE order_id = it.order_id) THEN
      RAISE EXCEPTION 'COD_REMITTANCE_INVALID:order:%', it.order_id USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO cod_remittance_items (remittance_id, order_id, amount) VALUES (rid, it.order_id, it.amount);
    IF o.payment_status = 'COD_COLLECTED' THEN
      UPDATE orders SET payment_status = 'COD_REMITTED', version = version + 1, updated_at = now() WHERE id = it.order_id;
      INSERT INTO order_status_history (order_id, dimension, from_value, to_value, actor_type, actor_id, note)
      VALUES (it.order_id, 'PAYMENT', 'COD_COLLECTED', 'COD_REMITTED', 'ADMIN', p_actor, p_courier || ' ' || p_reference);
    END IF;
    IF it.amount <> o.total THEN
      v_mis := v_mis || jsonb_build_object('order_id', it.order_id, 'expected', o.total, 'remitted', it.amount);
      PERFORM aq_raise_exception('COD_REMITTANCE_MISMATCH', 'COD_REMITTANCE_MISMATCH:' || it.order_id, it.order_id, NULL, NULL, it.amount - o.total,
                                 jsonb_build_object('remittance_id', rid, 'expected', o.total, 'remitted', it.amount, 'reference', p_reference));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('remittance_id', rid, 'mismatches', v_mis);
END $$ LANGUAGE plpgsql;
