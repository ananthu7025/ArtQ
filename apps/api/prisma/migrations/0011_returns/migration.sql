-- GENERATED from docs/database.md §8.5b by scripts/db-from-docs.mjs. Do not edit.
-- 0011 (task 5.5): returns, database.md §8.5b. Lock order (§4.1): order → order-owned rows (return request + items,
-- order items, refunds) → payment (inside aq_request_refund) → variants ↑ → products ↑. Additive (new functions).

-- The order's return dimension from its returns: OPEN while any is in progress, CLOSED when all are finished.
CREATE OR REPLACE FUNCTION aq_return_sync_order(p_order INT, p_by TEXT, p_actor INT) RETURNS TEXT AS $$
DECLARE cur TEXT; nxt TEXT;
BEGIN
  SELECT return_status::TEXT INTO cur FROM orders WHERE id = p_order;
  nxt := CASE WHEN EXISTS (SELECT 1 FROM return_requests WHERE order_id = p_order AND status NOT IN ('REJECTED', 'CLOSED', 'CANCELLED')) THEN 'OPEN'
              WHEN EXISTS (SELECT 1 FROM return_requests WHERE order_id = p_order) THEN 'CLOSED' ELSE 'NONE' END;
  IF nxt IS DISTINCT FROM cur THEN
    UPDATE orders SET return_status = nxt::"OrderReturnStatus", version = version + 1, updated_at = now() WHERE id = p_order;
    INSERT INTO order_status_history (order_id, dimension, from_value, to_value, actor_type, actor_id)
    VALUES (p_order, 'RETURN', cur, nxt, p_by::"ActorType", p_actor);
  END IF;
  RETURN nxt;
END $$ LANGUAGE plpgsql;

-- A customer's return request (p_user NULL = guest with the order access cookie). Delivered orders only, within the
-- return window after delivery. p_items = [{"order_item_id":1,"quantity":1}]; p_media = READY private images uploaded
-- for this order (owner scope return:<order id>) by the same user, not attached yet; they are claimed here.
CREATE OR REPLACE FUNCTION aq_request_return(p_order INT, p_user INT, p_reason TEXT, p_description TEXT, p_items JSONB,
  p_media INT[], p_window_hours INT) RETURNS INT AS $$
DECLARE o RECORD; it RECORD; v_delivered TIMESTAMPTZ; rid INT; n INT; v_media INT[];
BEGIN
  SELECT id, order_number, status, fulfilment_status INTO o FROM orders WHERE id = p_order FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND:order %', p_order USING ERRCODE = 'P0001'; END IF;
  IF o.fulfilment_status <> 'DELIVERED' OR o.status NOT IN ('CONFIRMED', 'COMPLETED') THEN
    RAISE EXCEPTION 'RETURN_NOT_ALLOWED:state' USING ERRCODE = 'P0001';
  END IF;
  SELECT delivered_at INTO v_delivered FROM shipments WHERE order_id = p_order;
  IF v_delivered IS NULL OR now() > v_delivered + make_interval(hours => p_window_hours) THEN
    RAISE EXCEPTION 'RETURN_NOT_ALLOWED:window' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0
     OR (SELECT count(DISTINCT x->>'order_item_id') FROM jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'RETURN_NOT_ALLOWED:items' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO return_requests (order_id, user_id, reason, description, status, updated_at)
  VALUES (p_order, p_user, p_reason::"ReturnReason", p_description, 'REQUESTED', now())
  RETURNING id INTO rid;
  FOR it IN SELECT (x->>'order_item_id')::INT AS item, (x->>'quantity')::INT AS q FROM jsonb_array_elements(p_items) x ORDER BY 1 LOOP
    IF it.q IS NULL OR it.q < 1 THEN RAISE EXCEPTION 'RETURN_NOT_ALLOWED:quantity:%', it.item USING ERRCODE = 'P0001'; END IF;
    UPDATE order_items SET return_requested_qty = return_requested_qty + it.q
     WHERE id = it.item AND order_id = p_order AND return_requested_qty + it.q <= quantity;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      IF NOT EXISTS (SELECT 1 FROM order_items WHERE id = it.item AND order_id = p_order) THEN
        RAISE EXCEPTION 'NOT_FOUND:order item %', it.item USING ERRCODE = 'P0001';
      END IF;
      RAISE EXCEPTION 'RETURN_NOT_ALLOWED:quantity:%', it.item USING ERRCODE = 'P0001';   -- more than is left to return
    END IF;
    INSERT INTO return_request_items (return_request_id, order_item_id, requested_qty) VALUES (rid, it.item, it.q);
  END LOOP;

  v_media := ARRAY(SELECT DISTINCT m FROM unnest(coalesce(p_media, '{}'::INT[])) m ORDER BY m);
  IF cardinality(v_media) > 0 THEN
    UPDATE media SET claimed_at = now()
     WHERE id = ANY(v_media) AND owner_scope = 'return:' || p_order AND uploaded_by IS NOT DISTINCT FROM p_user
       AND visibility = 'PRIVATE' AND kind = 'IMAGE' AND status = 'READY' AND deleted_at IS NULL AND claimed_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> cardinality(v_media) THEN RAISE EXCEPTION 'RETURN_NOT_ALLOWED:media' USING ERRCODE = 'P0001'; END IF;
    INSERT INTO return_request_media (return_request_id, media_id) SELECT rid, m FROM unnest(v_media) m;
  END IF;

  PERFORM aq_return_sync_order(p_order, 'CUSTOMER', p_user);
  PERFORM aq_emit('order', o.order_number, 'return.status_changed', jsonb_build_object('order_id', p_order, 'return_id', rid, 'to', 'REQUESTED'), ARRAY['email.customer']);
  RETURN rid;
END $$ LANGUAGE plpgsql;

-- Locks the return's order, then the return; raises NOT_FOUND / INVALID_TRANSITION unless it is in one of p_from.
CREATE OR REPLACE FUNCTION aq_return_lock(p_return INT, p_from TEXT[]) RETURNS return_requests AS $$
DECLARE r return_requests;
BEGIN
  SELECT * INTO r FROM return_requests WHERE id = p_return;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND:return %', p_return USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM orders WHERE id = r.order_id FOR NO KEY UPDATE;
  SELECT * INTO r FROM return_requests WHERE id = p_return FOR NO KEY UPDATE;
  IF NOT (r.status::TEXT = ANY(p_from)) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION:return % is %', p_return, r.status USING ERRCODE = 'P0001';
  END IF;
  RETURN r;
END $$ LANGUAGE plpgsql;

-- Staff decision. Approve: p_items = [{"order_item_id":1,"approved_qty":1}] (items not named approve 0; at least one
-- unit overall); the units not approved are released. Reject: every unit is released.
CREATE OR REPLACE FUNCTION aq_decide_return(p_return INT, p_approve BOOLEAN, p_items JSONB, p_note TEXT, p_actor INT) RETURNS TEXT AS $$
DECLARE r return_requests; it RECORD; v_to TEXT;
BEGIN
  r := aq_return_lock(p_return, ARRAY['REQUESTED']);
  IF p_approve THEN
    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
       OR (SELECT count(DISTINCT x->>'order_item_id') FROM jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items) THEN
      RAISE EXCEPTION 'RETURN_NOT_ALLOWED:items' USING ERRCODE = 'P0001';
    END IF;
    FOR it IN SELECT (x->>'order_item_id')::INT AS item, (x->>'approved_qty')::INT AS q, i.requested_qty
                FROM jsonb_array_elements(p_items) x
                LEFT JOIN return_request_items i ON i.return_request_id = p_return AND i.order_item_id = (x->>'order_item_id')::INT LOOP
      IF it.requested_qty IS NULL THEN RAISE EXCEPTION 'RETURN_NOT_ALLOWED:item:%', it.item USING ERRCODE = 'P0001'; END IF;
      IF it.q IS NULL OR it.q < 0 OR it.q > it.requested_qty THEN RAISE EXCEPTION 'RETURN_NOT_ALLOWED:approved:%', it.item USING ERRCODE = 'P0001'; END IF;
    END LOOP;
    UPDATE return_request_items i
       SET approved_qty = coalesce((SELECT (x->>'approved_qty')::INT FROM jsonb_array_elements(p_items) x WHERE (x->>'order_item_id')::INT = i.order_item_id), 0)
     WHERE return_request_id = p_return;
    IF (SELECT sum(approved_qty) FROM return_request_items WHERE return_request_id = p_return) = 0 THEN
      RAISE EXCEPTION 'RETURN_NOT_ALLOWED:nothing_approved' USING ERRCODE = 'P0001';
    END IF;
    v_to := 'APPROVED';
  ELSE
    v_to := 'REJECTED';
  END IF;
  FOR it IN SELECT order_item_id, requested_qty - CASE WHEN p_approve THEN approved_qty ELSE 0 END AS q
              FROM return_request_items WHERE return_request_id = p_return ORDER BY order_item_id LOOP
    IF it.q > 0 THEN UPDATE order_items SET return_requested_qty = return_requested_qty - it.q WHERE id = it.order_item_id; END IF;
  END LOOP;
  UPDATE return_requests SET status = v_to::"ReturnStatus", admin_note = p_note, decided_by = p_actor, decided_at = now(), updated_at = now()
   WHERE id = p_return;
  PERFORM aq_return_sync_order(r.order_id, 'ADMIN', p_actor);
  PERFORM aq_emit('order', (SELECT order_number FROM orders WHERE id = r.order_id), 'return.status_changed',
                  jsonb_build_object('order_id', r.order_id, 'return_id', p_return, 'to', v_to), ARRAY['email.customer']);
  RETURN v_to;
END $$ LANGUAGE plpgsql;

-- The parcel arrived: p_items = [{"order_item_id":1,"received_qty":1}] for approved items (not named = 0 received).
-- Not for a missing item, which never comes back.
CREATE OR REPLACE FUNCTION aq_receive_return(p_return INT, p_items JSONB, p_actor INT) RETURNS void AS $$
DECLARE r return_requests; it RECORD;
BEGIN
  r := aq_return_lock(p_return, ARRAY['APPROVED', 'IN_TRANSIT']);
  IF r.reason = 'MISSING_ITEM' THEN RAISE EXCEPTION 'RETURN_NOT_ALLOWED:missing_item' USING ERRCODE = 'P0001'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR (SELECT count(DISTINCT x->>'order_item_id') FROM jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'RETURN_NOT_ALLOWED:items' USING ERRCODE = 'P0001';
  END IF;
  FOR it IN SELECT (x->>'order_item_id')::INT AS item, (x->>'received_qty')::INT AS q, i.approved_qty
              FROM jsonb_array_elements(p_items) x
              LEFT JOIN return_request_items i ON i.return_request_id = p_return AND i.order_item_id = (x->>'order_item_id')::INT LOOP
    IF coalesce(it.approved_qty, 0) = 0 THEN RAISE EXCEPTION 'RETURN_NOT_ALLOWED:item:%', it.item USING ERRCODE = 'P0001'; END IF;
    IF it.q IS NULL OR it.q < 0 OR it.q > it.approved_qty THEN RAISE EXCEPTION 'RETURN_NOT_ALLOWED:received:%', it.item USING ERRCODE = 'P0001'; END IF;
  END LOOP;
  UPDATE return_request_items i
     SET received_qty = coalesce((SELECT (x->>'received_qty')::INT FROM jsonb_array_elements(p_items) x WHERE (x->>'order_item_id')::INT = i.order_item_id), 0)
   WHERE return_request_id = p_return AND approved_qty > 0;
  UPDATE return_requests SET status = 'RECEIVED', received_at = now(), updated_at = now() WHERE id = p_return;
  PERFORM aq_emit('order', (SELECT order_number FROM orders WHERE id = r.order_id), 'return.status_changed',
                  jsonb_build_object('order_id', r.order_id, 'return_id', p_return, 'to', 'RECEIVED'), ARRAY['email.customer']);
END $$ LANGUAGE plpgsql;

-- Inspection: p_items = [{"order_item_id":1,"sellable_qty":1,"damaged_qty":0}] for every item received (sellable +
-- damaged = received; items received 0 need not be named). Sellable units go back on the shelf (RETURN_RESTOCK),
-- damaged ones are recorded (RETURN_DAMAGED, no stock change). Received units count as returned; approved units that
-- never arrived are released.
CREATE OR REPLACE FUNCTION aq_inspect_return(p_return INT, p_items JSONB, p_actor INT) RETURNS void AS $$
DECLARE r return_requests; it RECORD; v RECORD; was_available INT;
BEGIN
  r := aq_return_lock(p_return, ARRAY['RECEIVED']);
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR (SELECT count(DISTINCT x->>'order_item_id') FROM jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'RETURN_NOT_ALLOWED:items' USING ERRCODE = 'P0001';
  END IF;
  FOR it IN SELECT (x->>'order_item_id')::INT AS item, i.received_qty FROM jsonb_array_elements(p_items) x
              LEFT JOIN return_request_items i ON i.return_request_id = p_return AND i.order_item_id = (x->>'order_item_id')::INT LOOP
    IF it.received_qty IS NULL THEN RAISE EXCEPTION 'RETURN_NOT_ALLOWED:item:%', it.item USING ERRCODE = 'P0001'; END IF;
  END LOOP;
  FOR it IN SELECT i.order_item_id, i.received_qty, (x->>'sellable_qty')::INT AS s, (x->>'damaged_qty')::INT AS d
              FROM return_request_items i
              LEFT JOIN jsonb_array_elements(p_items) x ON (x->>'order_item_id')::INT = i.order_item_id
             WHERE i.return_request_id = p_return AND i.received_qty IS NOT NULL ORDER BY i.order_item_id LOOP
    IF it.received_qty = 0 AND it.s IS NULL AND it.d IS NULL THEN it.s := 0; it.d := 0; END IF;
    IF it.s IS NULL OR it.d IS NULL OR it.s < 0 OR it.d < 0 OR it.s + it.d <> it.received_qty THEN
      RAISE EXCEPTION 'RETURN_NOT_ALLOWED:inspection:%', it.order_item_id USING ERRCODE = 'P0001';
    END IF;
    UPDATE return_request_items SET sellable_qty = it.s, damaged_qty = it.d WHERE return_request_id = p_return AND order_item_id = it.order_item_id;
  END LOOP;
  -- Received units are returned; approved units that never arrived no longer count against the item.
  UPDATE order_items oi SET returned_qty = oi.returned_qty + i.received_qty,
                            return_requested_qty = oi.return_requested_qty - (i.approved_qty - i.received_qty)
    FROM return_request_items i
   WHERE i.return_request_id = p_return AND i.order_item_id = oi.id AND i.received_qty IS NOT NULL;
  -- Stock: variants ascending, then products.
  FOR it IN SELECT oi.variant_id, sum(i.sellable_qty)::INT AS s, sum(i.damaged_qty)::INT AS d
              FROM return_request_items i JOIN order_items oi ON oi.id = i.order_item_id
             WHERE i.return_request_id = p_return AND oi.variant_id IS NOT NULL AND i.sellable_qty + i.damaged_qty > 0
             GROUP BY oi.variant_id ORDER BY oi.variant_id LOOP
    SELECT on_hand, reserved INTO v FROM product_variants WHERE id = it.variant_id FOR NO KEY UPDATE;
    was_available := v.on_hand - v.reserved;
    IF it.s > 0 THEN
      UPDATE product_variants SET on_hand = on_hand + it.s, version = version + 1 WHERE id = it.variant_id RETURNING on_hand, reserved INTO v;
      INSERT INTO inventory_movements (variant_id, reason, on_hand_delta, reserved_delta, on_hand_after, reserved_after, order_id, return_request_id, actor_id)
      VALUES (it.variant_id, 'RETURN_RESTOCK', it.s, 0, v.on_hand, v.reserved, r.order_id, p_return, p_actor);
      IF was_available <= 0 AND v.on_hand - v.reserved > 0 THEN
        PERFORM aq_emit('variant', it.variant_id::TEXT, 'variant.back_in_stock', jsonb_build_object('variant_id', it.variant_id), ARRAY['restock.notify']);
      END IF;
    END IF;
    IF it.d > 0 THEN
      INSERT INTO inventory_movements (variant_id, reason, on_hand_delta, reserved_delta, on_hand_after, reserved_after, order_id, return_request_id, note, actor_id)
      VALUES (it.variant_id, 'RETURN_DAMAGED', 0, 0, v.on_hand, v.reserved, r.order_id, p_return, it.d || ' damaged unit(s), not restocked', p_actor);
    END IF;
  END LOOP;
  PERFORM aq_refresh_products(ARRAY(SELECT DISTINCT oi.product_id FROM return_request_items i JOIN order_items oi ON oi.id = i.order_item_id
                                     WHERE i.return_request_id = p_return AND oi.product_id IS NOT NULL AND i.sellable_qty > 0));
  UPDATE return_requests SET status = 'INSPECTED', inspected_at = now(), updated_at = now() WHERE id = p_return;   -- trigger: inspection complete
END $$ LANGUAGE plpgsql;

-- The refund for an inspected return (or an approved missing item). p_items = [{"order_item_id":1,"quantity":1,"amount":45000}];
-- p_payment as for aq_request_refund (the applied payment; NULL = COD bank transfer). Shipping at staff discretion
-- (merchant fault); never the COD fee. Several refunds per return are allowed while the bounds hold.
CREATE OR REPLACE FUNCTION aq_request_return_refund(p_return INT, p_payment INT, p_items JSONB, p_shipping INT, p_reason TEXT,
  p_idem_key TEXT, p_actor INT) RETURNS INT AS $$
DECLARE r return_requests; it RECORD; v_items JSONB; rid INT;
BEGIN
  r := aq_return_lock(p_return, ARRAY['INSPECTED', 'APPROVED', 'REFUNDED']);
  IF r.status = 'APPROVED' AND r.reason <> 'MISSING_ITEM' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION:return % is APPROVED (inspect it first)', p_return USING ERRCODE = 'P0001';
  END IF;
  IF r.status = 'REFUNDED' AND r.reason <> 'MISSING_ITEM' AND r.inspected_at IS NULL THEN
    RAISE EXCEPTION 'INVARIANT: return % refunded before inspection', p_return;
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR (SELECT count(DISTINCT x->>'order_item_id') FROM jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'RETURN_NOT_ALLOWED:items' USING ERRCODE = 'P0001';
  END IF;
  FOR it IN SELECT (x->>'order_item_id')::INT AS item, (x->>'quantity')::INT AS q, (x->>'amount')::INT AS a,
                   CASE WHEN r.reason = 'MISSING_ITEM' THEN i.approved_qty ELSE i.received_qty END AS base,
                   oi.quantity AS bought, oi.net_amount,
                   (SELECT coalesce(sum(ri.quantity), 0) FROM refund_items ri JOIN refunds f ON f.id = ri.refund_id
                     WHERE f.return_request_id = p_return AND f.status NOT IN ('FAILED', 'CANCELLED') AND ri.order_item_id = i.order_item_id) AS used
              FROM jsonb_array_elements(p_items) x
              LEFT JOIN return_request_items i ON i.return_request_id = p_return AND i.order_item_id = (x->>'order_item_id')::INT
              LEFT JOIN order_items oi ON oi.id = i.order_item_id LOOP
    IF it.base IS NULL OR it.base = 0 THEN RAISE EXCEPTION 'RETURN_NOT_ALLOWED:item:%', it.item USING ERRCODE = 'P0001'; END IF;
    IF it.q IS NULL OR it.a IS NULL OR it.q < 1 OR it.a < 1 THEN RAISE EXCEPTION 'REFUND_AMOUNT_INVALID:%', it.item USING ERRCODE = 'P0001'; END IF;
    IF it.used + it.q > it.base OR it.a > ceil(it.net_amount::NUMERIC * it.q / it.bought) THEN
      RAISE EXCEPTION 'REFUND_EXCEEDS_CAPACITY:return:%', it.item USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(jsonb_build_object('order_item_id', oi.id, 'quantity', (x->>'quantity')::INT, 'amount', (x->>'amount')::INT,
           'tax_amount', CASE WHEN oi.net_amount = 0 THEN 0 ELSE round(oi.tax_amount::NUMERIC * (x->>'amount')::INT / oi.net_amount)::INT END)
           ORDER BY oi.id), '[]'::JSONB)
    INTO v_items FROM jsonb_array_elements(p_items) x JOIN order_items oi ON oi.id = (x->>'order_item_id')::INT;
  rid := aq_request_refund(r.order_id, p_payment, 'RETURN', v_items, coalesce(p_shipping, 0), 0, 0, p_reason, p_idem_key, p_actor);
  UPDATE refunds SET return_request_id = p_return WHERE id = rid;
  UPDATE return_requests SET status = 'REFUNDED', updated_at = now() WHERE id = p_return AND status <> 'REFUNDED';
  RETURN rid;
END $$ LANGUAGE plpgsql;

-- The simple steps. IN_TRANSIT: an approved return is on its way back (not for a missing item). CLOSED: done, after
-- inspection or refund (a missing item also straight from APPROVED). CANCELLED: before receipt; every unit still
-- counted against the items is released. p_note is kept on the return when given.
CREATE OR REPLACE FUNCTION aq_set_return_status(p_return INT, p_to TEXT, p_note TEXT, p_actor INT) RETURNS void AS $$
DECLARE r return_requests; it RECORD;
BEGIN
  r := aq_return_lock(p_return, CASE p_to WHEN 'IN_TRANSIT' THEN ARRAY['APPROVED']
                                          WHEN 'CLOSED' THEN ARRAY['INSPECTED', 'REFUNDED', 'APPROVED']
                                          WHEN 'CANCELLED' THEN ARRAY['REQUESTED', 'APPROVED', 'IN_TRANSIT']
                                          ELSE ARRAY[]::TEXT[] END);
  IF (p_to = 'IN_TRANSIT' AND r.reason = 'MISSING_ITEM') OR (p_to = 'CLOSED' AND r.status = 'APPROVED' AND r.reason <> 'MISSING_ITEM') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION:return % is % (%)', p_return, r.status, r.reason USING ERRCODE = 'P0001';
  END IF;
  IF p_to = 'CANCELLED' THEN
    FOR it IN SELECT order_item_id, coalesce(approved_qty, requested_qty) AS q FROM return_request_items
               WHERE return_request_id = p_return ORDER BY order_item_id LOOP
      IF it.q > 0 THEN UPDATE order_items SET return_requested_qty = return_requested_qty - it.q WHERE id = it.order_item_id; END IF;
    END LOOP;
  END IF;
  UPDATE return_requests SET status = p_to::"ReturnStatus", admin_note = coalesce(p_note, admin_note),
         closed_at = CASE WHEN p_to IN ('CLOSED', 'CANCELLED') THEN now() ELSE closed_at END, updated_at = now()
   WHERE id = p_return;
  PERFORM aq_return_sync_order(r.order_id, 'ADMIN', p_actor);
END $$ LANGUAGE plpgsql;
