-- GENERATED from docs/database.md §8.3a by scripts/db-from-docs.mjs. Do not edit.
-- 0009 (task 5.3): aq_cancel_order, a placed or confirmed order cancelled before it ships (database.md §4.2,
-- §8.3a). Customers may cancel while the order is not packed; staff also while it is packed. One transaction in the
-- global lock order (§4.1): order → payment and order items (refund request) → reservations → variants ↑ →
-- products ↑ (sold counts) → coupon. A prepaid order gets one CANCELLATION refund of everything still refundable on
-- its applied payment (items, shipping, COD fee; capacity reserved by aq_request_refund, sent by refund.send); a COD
-- order's payment becomes NOT_COLLECTED. The coupon use is reversed (D-14, aq_reverse_coupon). A second call finds
-- the order CANCELLED and raises INVALID_TRANSITION, so nothing happens twice. Unpaid orders (PENDING_PAYMENT) use
-- aq_release_unpaid_order instead. Additive (a new function).
CREATE OR REPLACE FUNCTION aq_cancel_order(p_order INT, p_by TEXT, p_actor INT, p_reason TEXT, p_notify BOOLEAN)
RETURNS JSONB AS $$
DECLARE o RECORD; pay RECORD; r RECORD; v RECORD; it RECORD; n INT; v_items JSONB; v_ship INT; v_cod INT; rid INT; v_new_pay TEXT;
BEGIN
  IF p_by NOT IN ('CUSTOMER', 'ADMIN') THEN RAISE EXCEPTION 'bad actor %', p_by; END IF;
  SELECT id, order_number, status, payment_status, fulfilment_status, payment_method, shipping_fee, cod_fee,
         refund_reserved_shipping, refund_reserved_cod_fee INTO o
    FROM orders WHERE id = p_order FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND:order %', p_order USING ERRCODE = 'P0001'; END IF;
  IF o.status NOT IN ('PLACED', 'CONFIRMED')
     OR NOT (o.fulfilment_status = 'UNFULFILLED' OR (p_by = 'ADMIN' AND o.fulfilment_status = 'PACKED')) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION:order % is %/%/%', p_order, o.status, o.fulfilment_status, o.payment_status USING ERRCODE = 'P0001';
  END IF;

  v_new_pay := CASE WHEN o.payment_status = 'COD_PENDING' THEN 'NOT_COLLECTED' ELSE o.payment_status::TEXT END;
  UPDATE orders SET status = 'CANCELLED', payment_status = v_new_pay::"OrderPaymentStatus", cancelled_at = now(), cancel_reason = p_reason,
         cancelled_by = p_by::"ActorType", version = version + 1, updated_at = now()
   WHERE id = p_order AND status IN ('PLACED', 'CONFIRMED');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'INVARIANT: order % could not transition to CANCELLED', p_order; END IF;
  INSERT INTO order_status_history (order_id, dimension, from_value, to_value, actor_type, actor_id, note)
  VALUES (p_order, 'ORDER', o.status, 'CANCELLED', p_by::"ActorType", p_actor, p_reason);
  IF v_new_pay <> o.payment_status::TEXT THEN
    INSERT INTO order_status_history (order_id, dimension, from_value, to_value, actor_type, actor_id)
    VALUES (p_order, 'PAYMENT', o.payment_status, v_new_pay, p_by::"ActorType", p_actor);
  END IF;

  -- Prepaid: refund whatever is still refundable on the applied payment (nothing twice: capacity is reserved).
  IF o.payment_method = 'RAZORPAY' AND o.payment_status IN ('PAID', 'PARTIALLY_REFUNDED') THEN
    SELECT id INTO pay FROM payments WHERE order_id = p_order AND allocation = 'APPLIED' ORDER BY id LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVARIANT: paid order % has no applied payment', p_order; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('order_item_id', id, 'quantity', quantity - refund_reserved_qty,
             'amount', net_amount - refund_reserved_amount,
             'tax_amount', CASE WHEN net_amount = 0 THEN 0 ELSE round(tax_amount::NUMERIC * (net_amount - refund_reserved_amount) / net_amount)::INT END)
             ORDER BY id), '[]'::JSONB)
      INTO v_items FROM order_items WHERE order_id = p_order AND net_amount - refund_reserved_amount > 0;
    v_ship := o.shipping_fee - o.refund_reserved_shipping;
    v_cod := o.cod_fee - o.refund_reserved_cod_fee;
    IF jsonb_array_length(v_items) > 0 OR v_ship > 0 OR v_cod > 0 THEN
      rid := aq_request_refund(p_order, pay.id, 'CANCELLATION', v_items, v_ship, v_cod, 0, coalesce(p_reason, 'Order cancelled'),
                               'cancel-' || p_order, p_actor);
    END IF;
  END IF;

  FOR r IN SELECT id, variant_id, quantity FROM inventory_reservations
            WHERE order_id = p_order AND status = 'ACTIVE' ORDER BY variant_id, id LOOP
    UPDATE product_variants SET reserved = reserved - r.quantity, version = version + 1 WHERE id = r.variant_id
    RETURNING on_hand, reserved INTO v;
    UPDATE inventory_reservations SET status = 'RELEASED', released_at = now(), release_reason = 'cancelled' WHERE id = r.id;
    INSERT INTO inventory_movements (variant_id, reason, on_hand_delta, reserved_delta, on_hand_after, reserved_after, order_id, reservation_id, actor_id)
    VALUES (r.variant_id, 'RELEASE', 0, -r.quantity, v.on_hand, v.reserved, p_order, r.id, p_actor);
    IF v.on_hand - v.reserved > 0 AND v.on_hand - v.reserved - r.quantity <= 0 THEN
      PERFORM aq_emit('variant', r.variant_id::TEXT, 'variant.back_in_stock', jsonb_build_object('variant_id', r.variant_id), ARRAY['restock.notify']);
    END IF;
  END LOOP;
  FOR it IN SELECT product_id, sum(quantity)::INT AS q FROM order_items WHERE order_id = p_order GROUP BY product_id ORDER BY product_id LOOP
    UPDATE products SET sold_count = greatest(sold_count - it.q, 0) WHERE id = it.product_id;
  END LOOP;
  PERFORM aq_refresh_products(ARRAY(SELECT DISTINCT product_id FROM order_items WHERE order_id = p_order));
  PERFORM aq_reverse_coupon(p_order);

  IF p_notify THEN
    PERFORM aq_emit('order', o.order_number, 'order.cancelled', jsonb_build_object('order_id', p_order, 'refund_id', rid), ARRAY['email.customer']);
  END IF;
  RETURN jsonb_build_object('refund_id', rid, 'payment_status', v_new_pay);
END $$ LANGUAGE plpgsql;
