-- 0007 (task 4.7): aq_place_cod_order, the COD branch of checkout (database.md §5 "COD checkout": PLACED, COD_PENDING,
-- coupon REDEEMED). Called in checkout TX1 right after aq_reserve_order / aq_reserve_coupon for a COD order, and by the
-- payment retry that switches a pending order to COD (task 4.8). Mirrors the APPLIED branch of aq_apply_provider_payment
-- without a payment: order PLACED + COD_PENDING (reservations stay ACTIVE until dispatch), open attempts CLOSED, sold
-- counts, coupon RESERVED → REDEEMED (counters gated by that row transition), cart CONVERTED, two history rows and the
-- order.placed event. Lock order (§4.1): order → products ↑ → coupon. A repeated call returns 'DUPLICATE' and changes
-- nothing. Additive (a new function).
CREATE OR REPLACE FUNCTION aq_place_cod_order(p_order INT, p_actor TEXT) RETURNS TEXT AS $$
DECLARE o RECORD; red RECORD; it RECORD; n INT;
BEGIN
  SELECT id, order_number, status, payment_status, payment_method, cart_id INTO o FROM orders WHERE id = p_order FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND:order %', p_order USING ERRCODE = 'P0001'; END IF;
  IF o.status = 'PLACED' AND o.payment_status = 'COD_PENDING' THEN RETURN 'DUPLICATE'; END IF;
  IF o.payment_method <> 'COD' OR o.status <> 'PENDING_PAYMENT' OR o.payment_status <> 'UNPAID' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION:order % is %/%/%', p_order, o.payment_method, o.status, o.payment_status USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE order_id = p_order AND status IN ('AUTHORIZED','CAPTURED')) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION:order % has an online payment', p_order USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = p_order
              AND NOT EXISTS (SELECT 1 FROM inventory_reservations r WHERE r.order_item_id = oi.id AND r.status = 'ACTIVE')) THEN
    RAISE EXCEPTION 'INVARIANT: order % has an item without an active reservation', p_order;
  END IF;

  UPDATE orders SET status = 'PLACED', payment_status = 'COD_PENDING', placed_at = now(), expires_at = NULL, version = version + 1
   WHERE id = p_order AND status = 'PENDING_PAYMENT' AND payment_status = 'UNPAID';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'INVARIANT: order % could not transition to PLACED', p_order; END IF;
  UPDATE payment_attempts SET status = 'CLOSED' WHERE order_id = p_order AND status IN ('CREATING','CREATED','PROVIDER_UNKNOWN','CREATION_FAILED');

  FOR it IN SELECT product_id, sum(quantity)::INT AS q FROM order_items WHERE order_id = p_order GROUP BY product_id ORDER BY product_id LOOP
    UPDATE products SET sold_count = sold_count + it.q WHERE id = it.product_id;
  END LOOP;

  UPDATE coupon_redemptions SET status = 'REDEEMED', redeemed_at = now()
   WHERE order_id = p_order AND status = 'RESERVED' RETURNING coupon_id, over_limit INTO red;
  IF FOUND AND NOT red.over_limit THEN
    PERFORM 1 FROM coupons WHERE id = red.coupon_id FOR NO KEY UPDATE;
    UPDATE coupons SET reserved_count = reserved_count - 1, redeemed_count = redeemed_count + 1 WHERE id = red.coupon_id;
  END IF;

  UPDATE carts SET status = 'CONVERTED' WHERE id = o.cart_id AND status = 'ACTIVE';
  PERFORM aq_history(p_order, 'ORDER', 'PENDING_PAYMENT', 'PLACED', p_actor);
  PERFORM aq_history(p_order, 'PAYMENT', 'UNPAID', 'COD_PENDING', p_actor);
  PERFORM aq_emit('order', o.order_number, 'order.placed', jsonb_build_object('order_id', p_order, 'late', false),
                  ARRAY['email.customer','email.admin','notify.admin']);
  RETURN 'PLACED';
END $$ LANGUAGE plpgsql;
