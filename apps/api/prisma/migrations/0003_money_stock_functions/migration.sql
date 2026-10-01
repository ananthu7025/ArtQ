-- GENERATED from docs/database.md §6b by scripts/db-from-docs.mjs. Do not edit.
-- 0003_money_stock_functions.sql
-- The money/stock-critical transactions, implemented ONCE as database functions and called by the
-- API services and workers (Prisma $queryRaw). Each function runs inside the caller's transaction and
-- performs NO network I/O. Lock order: database.md §4.1. Every business side effect is gated by an
-- affected-row check on the state transition that authorises it.

-- ── Small helpers ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION aq_history(p_order INT, p_dim TEXT, p_from TEXT, p_to TEXT, p_actor TEXT, p_note TEXT DEFAULT NULL)
RETURNS void AS $$
  INSERT INTO order_status_history (order_id, dimension, from_value, to_value, actor_type, note)
  VALUES (p_order, p_dim::"StatusDimension", p_from, p_to, p_actor::"ActorType", p_note);
$$ LANGUAGE sql;

-- Outbox: one event row + one delivery row per consumer, in the caller's transaction.
CREATE OR REPLACE FUNCTION aq_emit(p_agg_type TEXT, p_agg_id TEXT, p_type TEXT, p_payload JSONB, p_consumers TEXT[])
RETURNS BIGINT AS $$
DECLARE e BIGINT;
BEGIN
  INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
  VALUES (p_agg_type, p_agg_id, p_type, p_payload) RETURNING id INTO e;
  INSERT INTO outbox_deliveries (event_id, consumer) SELECT e, c FROM unnest(p_consumers) AS c;
  RETURN e;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aq_raise_exception(p_type TEXT, p_dedupe TEXT, p_order INT, p_payment INT, p_refund INT, p_amount INT, p_details JSONB)
RETURNS BOOLEAN AS $$
DECLARE eid INT;
BEGIN
  INSERT INTO payment_exceptions (type, dedupe_key, order_id, payment_id, refund_id, amount, details)
  VALUES (p_type::"ExceptionType", p_dedupe, p_order, p_payment, p_refund, p_amount, COALESCE(p_details, '{}'))
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO eid;
  IF eid IS NOT NULL THEN
    IF p_order IS NOT NULL THEN UPDATE orders SET has_open_exception = TRUE WHERE id = p_order; END IF;
    -- aggregate id = exception row id (dedupe keys can exceed outbox_events.aggregate_id's 40 characters)
    PERFORM aq_emit('payment_exception', eid::TEXT, 'payment.exception_raised',
                    jsonb_build_object('type', p_type, 'order_id', p_order, 'dedupe_key', p_dedupe), ARRAY['notify.admin']);
  END IF;
  RETURN eid IS NOT NULL;
END $$ LANGUAGE plpgsql;

-- Product aggregates; locks products in ascending id order (lock-order step "products").
CREATE OR REPLACE FUNCTION aq_refresh_products(p_ids INT[]) RETURNS void AS $$
DECLARE pid INT;
BEGIN
  FOR pid IN SELECT DISTINCT x FROM unnest(p_ids) AS x WHERE x IS NOT NULL ORDER BY 1 LOOP
    UPDATE products p SET min_price = a.min_price, max_price = a.max_price, max_mrp = a.max_mrp,
                          available_qty = a.available_qty, active_variant_count = a.active_variant_count
      FROM product_aggregates(pid) a WHERE p.id = pid;
  END LOOP;
END $$ LANGUAGE plpgsql;

-- ── Idempotency (api.md §1.2) ──────────────────────────────────────────
-- p_hash = sha256(canonical JSON {operation, target, scope, body}) computed by the API.
-- Ownership is fenced: NEW and TAKEOVER issue a fresh owner_token and generation+1. Every later write
-- (attach resource, renew, complete) must present the token, inside the same transaction as the domain
-- change it guards, so a stale owner is rejected before its mutation can commit.
CREATE OR REPLACE FUNCTION aq_idempotency_begin(p_scope TEXT, p_op TEXT, p_key TEXT, p_target TEXT, p_hash TEXT, p_lock_s INT DEFAULT 60)
RETURNS TABLE (outcome TEXT, response_code INT, response_body JSONB, resource_type TEXT, resource_id TEXT, owner_token UUID, generation INT) AS $$
#variable_conflict use_column
DECLARE k idempotency_keys%ROWTYPE; t UUID; g INT;
BEGIN
  INSERT INTO idempotency_keys (scope, operation, key, target_resource, request_hash, status, locked_until, expires_at, owner_token, generation)
  VALUES (p_scope, p_op, p_key, p_target, p_hash, 'PROCESSING', now() + make_interval(secs => p_lock_s), now() + interval '24 hours',
          gen_random_uuid(), 1)
  ON CONFLICT (scope, operation, key) DO NOTHING
  RETURNING idempotency_keys.owner_token, idempotency_keys.generation INTO t, g;
  IF FOUND THEN
    RETURN QUERY SELECT 'NEW'::TEXT, NULL::INT, NULL::JSONB, NULL::TEXT, NULL::TEXT, t, g; RETURN;
  END IF;
  SELECT * INTO k FROM idempotency_keys i WHERE i.scope = p_scope AND i.operation = p_op AND i.key = p_key FOR NO KEY UPDATE;
  IF k.target_resource <> p_target OR k.request_hash <> p_hash THEN
    RETURN QUERY SELECT 'CONFLICT'::TEXT, 422, NULL::JSONB, NULL::TEXT, NULL::TEXT, NULL::UUID, NULL::INT; RETURN;   -- IDEMPOTENCY_KEY_REUSED
  ELSIF k.status = 'COMPLETED' THEN
    RETURN QUERY SELECT 'REPLAY'::TEXT, k.response_code, k.response_body, k.resource_type::TEXT, k.resource_id::TEXT, NULL::UUID, NULL::INT; RETURN;
  ELSIF k.locked_until > now() THEN
    RETURN QUERY SELECT 'IN_PROGRESS'::TEXT, 409, NULL::JSONB, NULL::TEXT, NULL::TEXT, NULL::UUID, NULL::INT; RETURN;  -- REQUEST_IN_PROGRESS
  END IF;
  -- Lease expired: the previous owner is presumed dead. Fence it out with a new token + generation.
  UPDATE idempotency_keys SET locked_until = now() + make_interval(secs => p_lock_s),
         owner_token = gen_random_uuid(), generation = idempotency_keys.generation + 1
   WHERE id = k.id
  RETURNING idempotency_keys.owner_token, idempotency_keys.generation INTO t, g;
  RETURN QUERY SELECT 'TAKEOVER'::TEXT, NULL::INT, NULL::JSONB, k.resource_type::TEXT, k.resource_id::TEXT, t, g;  -- resume from resource
END $$ LANGUAGE plpgsql;

-- First statement of every transaction that acts for an idempotent request: locks the record and proves ownership.
CREATE OR REPLACE FUNCTION aq_idempotency_assert_owner(p_scope TEXT, p_op TEXT, p_key TEXT, p_token UUID) RETURNS void AS $$
BEGIN
  PERFORM 1 FROM idempotency_keys
   WHERE scope = p_scope AND operation = p_op AND key = p_key AND status = 'PROCESSING' AND owner_token = p_token
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_OWNERSHIP_LOST:%', p_key USING ERRCODE = 'P0003'; END IF;
END $$ LANGUAGE plpgsql;

-- Record the resource created for this request (same transaction as its creation).
CREATE OR REPLACE FUNCTION aq_idempotency_attach(p_scope TEXT, p_op TEXT, p_key TEXT, p_token UUID, p_rtype TEXT, p_rid TEXT)
RETURNS void AS $$
BEGIN
  PERFORM aq_idempotency_assert_owner(p_scope, p_op, p_key, p_token);
  UPDATE idempotency_keys SET resource_type = p_rtype, resource_id = p_rid
   WHERE scope = p_scope AND operation = p_op AND key = p_key AND owner_token = p_token;
END $$ LANGUAGE plpgsql;

-- Extend the lease during a slow provider call. FALSE ⇒ ownership lost: stop and do not call out again.
CREATE OR REPLACE FUNCTION aq_idempotency_renew(p_scope TEXT, p_op TEXT, p_key TEXT, p_token UUID, p_lock_s INT DEFAULT 60)
RETURNS BOOLEAN AS $$
DECLARE n INT;
BEGIN
  UPDATE idempotency_keys SET locked_until = now() + make_interval(secs => p_lock_s)
   WHERE scope = p_scope AND operation = p_op AND key = p_key AND status = 'PROCESSING' AND owner_token = p_token;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aq_idempotency_complete(p_scope TEXT, p_op TEXT, p_key TEXT, p_token UUID, p_code INT, p_body JSONB, p_rtype TEXT, p_rid TEXT)
RETURNS void AS $$
BEGIN
  UPDATE idempotency_keys SET status = 'COMPLETED', response_code = p_code, response_body = p_body,
         resource_type = COALESCE(p_rtype, resource_type), resource_id = COALESCE(p_rid, resource_id), completed_at = now()
   WHERE scope = p_scope AND operation = p_op AND key = p_key AND status = 'PROCESSING' AND owner_token = p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_OWNERSHIP_LOST:%', p_key USING ERRCODE = 'P0003'; END IF;
END $$ LANGUAGE plpgsql;

-- ── Inventory ───────────────────────────────────────────────────────────
-- Reserve every line of an order (TX1 of checkout). Variants ascending, then products ascending.
CREATE OR REPLACE FUNCTION aq_reserve_order(p_order INT) RETURNS void AS $$
DECLARE r RECORD; v RECORD; rid INT;
BEGIN
  PERFORM 1 FROM orders WHERE id = p_order FOR NO KEY UPDATE;
  FOR r IN SELECT oi.id, oi.variant_id, oi.quantity FROM order_items oi WHERE oi.order_id = p_order ORDER BY oi.variant_id, oi.id LOOP
    UPDATE product_variants SET reserved = reserved + r.quantity, version = version + 1, updated_at = now()
     WHERE id = r.variant_id AND is_active AND deleted_at IS NULL AND price IS NOT NULL AND on_hand - reserved >= r.quantity
    RETURNING on_hand, reserved INTO v;
    IF NOT FOUND THEN RAISE EXCEPTION 'OUT_OF_STOCK:%', r.variant_id USING ERRCODE = 'P0001'; END IF;
    INSERT INTO inventory_reservations (order_id, order_item_id, variant_id, quantity) VALUES (p_order, r.id, r.variant_id, r.quantity)
    RETURNING id INTO rid;
    INSERT INTO inventory_movements (variant_id, reason, on_hand_delta, reserved_delta, on_hand_after, reserved_after, order_id, reservation_id)
    VALUES (r.variant_id, 'RESERVE', 0, r.quantity, v.on_hand, v.reserved, p_order, rid);
  END LOOP;
  PERFORM aq_refresh_products(ARRAY(SELECT product_id FROM order_items WHERE order_id = p_order));
END $$ LANGUAGE plpgsql;

-- Re-reserve after a late capture; all-or-nothing via a subtransaction.
CREATE OR REPLACE FUNCTION aq_reacquire_order(p_order INT) RETURNS BOOLEAN AS $$
BEGIN
  BEGIN
    PERFORM aq_reserve_order(p_order);
    RETURN TRUE;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN FALSE;                                   -- savepoint rolled back; nothing reserved
  END;
END $$ LANGUAGE plpgsql;

-- Release reservations of an unpaid order (expiry / cancellation before payment).
CREATE OR REPLACE FUNCTION aq_release_unpaid_order(p_order INT, p_new_status TEXT, p_reason TEXT, p_actor TEXT)
RETURNS TEXT AS $$
DECLARE o RECORD; r RECORD; v RECORD; red RECORD;
BEGIN
  IF p_new_status NOT IN ('EXPIRED', 'CANCELLED') THEN RAISE EXCEPTION 'bad status %', p_new_status; END IF;
  SELECT id, order_number, status, payment_status INTO o FROM orders WHERE id = p_order FOR NO KEY UPDATE;
  IF o.status <> 'PENDING_PAYMENT' OR o.payment_status <> 'UNPAID' THEN RETURN 'SKIPPED'; END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE order_id = p_order AND allocation IS NULL AND status = 'AUTHORIZED') THEN
    RETURN 'SKIPPED';                  -- a live authorization: apply/capture or reassess first
  END IF;
  FOR r IN SELECT id, variant_id, quantity FROM inventory_reservations
            WHERE order_id = p_order AND status = 'ACTIVE' ORDER BY variant_id, id LOOP
    UPDATE product_variants SET reserved = reserved - r.quantity, version = version + 1 WHERE id = r.variant_id
    RETURNING on_hand, reserved INTO v;
    UPDATE inventory_reservations SET status = 'RELEASED', released_at = now(), release_reason = p_reason WHERE id = r.id;
    INSERT INTO inventory_movements (variant_id, reason, on_hand_delta, reserved_delta, on_hand_after, reserved_after, order_id, reservation_id)
    VALUES (r.variant_id, 'RELEASE', 0, -r.quantity, v.on_hand, v.reserved, p_order, r.id);
    IF v.on_hand - v.reserved > 0 AND v.on_hand - v.reserved - r.quantity <= 0 THEN
      PERFORM aq_emit('variant', r.variant_id::TEXT, 'variant.back_in_stock', jsonb_build_object('variant_id', r.variant_id), ARRAY['restock.notify']);
    END IF;
  END LOOP;
  PERFORM aq_refresh_products(ARRAY(SELECT product_id FROM order_items WHERE order_id = p_order));
  UPDATE coupon_redemptions SET status = 'RELEASED', released_at = now()
   WHERE order_id = p_order AND status = 'RESERVED' RETURNING coupon_id, over_limit INTO red;
  IF FOUND AND NOT red.over_limit THEN
    UPDATE coupons SET reserved_count = reserved_count - 1 WHERE id = red.coupon_id;   -- never touches redeemed_count
  END IF;
  UPDATE payment_attempts SET status = 'CLOSED'
   WHERE order_id = p_order AND status IN ('CREATING','CREATED','PROVIDER_UNKNOWN','CREATION_FAILED');
  UPDATE orders SET status = p_new_status::"OrderStatus",
         expired_at = CASE WHEN p_new_status = 'EXPIRED' THEN now() END,
         cancelled_at = CASE WHEN p_new_status = 'CANCELLED' THEN now() END,
         cancel_reason = CASE WHEN p_new_status = 'CANCELLED' THEN p_reason END,
         cancelled_by = CASE WHEN p_new_status = 'CANCELLED' THEN p_actor::"ActorType" END,
         expires_at = NULL, version = version + 1
   WHERE id = p_order AND status = 'PENDING_PAYMENT';
  PERFORM aq_history(p_order, 'ORDER', 'PENDING_PAYMENT', p_new_status, p_actor, p_reason);
  PERFORM aq_emit('order', o.order_number, 'order.' || lower(p_new_status), jsonb_build_object('order_id', p_order), ARRAY['email.customer']);
  RETURN p_new_status;
END $$ LANGUAGE plpgsql;

-- Physical stock changes (recount / adjustment / write-off), batch, variants ascending then products.
-- Never writes `reserved`. p_rows = [{"variant_id":1,"kind":"RECOUNT"|"ADJUSTMENT"|"DAMAGE_WRITE_OFF","quantity":n,"note":"…"}]
CREATE OR REPLACE FUNCTION aq_adjust_on_hand(p_rows JSONB, p_actor INT, p_import INT DEFAULT NULL) RETURNS void AS $$
DECLARE r RECORD; v RECORD; new_on_hand INT; was_available INT;
BEGIN
  FOR r IN SELECT * FROM jsonb_to_recordset(p_rows) AS x(variant_id INT, kind TEXT, quantity INT, note TEXT) ORDER BY variant_id LOOP
    SELECT id, product_id, on_hand, reserved INTO v FROM product_variants WHERE id = r.variant_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND:variant:%', r.variant_id; END IF;
    was_available := v.on_hand - v.reserved;
    new_on_hand := CASE r.kind WHEN 'RECOUNT' THEN r.quantity
                               WHEN 'ADJUSTMENT' THEN v.on_hand + r.quantity
                               WHEN 'DAMAGE_WRITE_OFF' THEN v.on_hand - abs(r.quantity) END;
    IF new_on_hand IS NULL OR new_on_hand < 0 THEN RAISE EXCEPTION 'INVALID_ADJUSTMENT:%', r.variant_id; END IF;
    UPDATE product_variants SET on_hand = new_on_hand, version = version + 1,
           inventory_counted_at = CASE WHEN r.kind = 'RECOUNT' THEN now() ELSE inventory_counted_at END
     WHERE id = v.id;
    INSERT INTO inventory_movements (variant_id, reason, on_hand_delta, reserved_delta, on_hand_after, reserved_after, import_id, note, actor_id)
    VALUES (v.id, r.kind::"InventoryReason", new_on_hand - v.on_hand, 0, new_on_hand, v.reserved, p_import, r.note, p_actor);
    IF new_on_hand < v.reserved THEN
      PERFORM aq_raise_exception('OVERSOLD', 'OVERSOLD:' || v.id || ':' || current_date, NULL, NULL, NULL, NULL,
                                 jsonb_build_object('variant_id', v.id, 'on_hand', new_on_hand, 'reserved', v.reserved));
    END IF;
    IF was_available <= 0 AND new_on_hand - v.reserved > 0 THEN
      PERFORM aq_emit('variant', v.id::TEXT, 'variant.back_in_stock', jsonb_build_object('variant_id', v.id), ARRAY['restock.notify']);
    END IF;
  END LOOP;
  PERFORM aq_refresh_products(ARRAY(SELECT product_id FROM product_variants
                                     WHERE id IN (SELECT (x->>'variant_id')::INT FROM jsonb_array_elements(p_rows) x)));
END $$ LANGUAGE plpgsql;

-- Catalogue edit of several variants of one product: variants ascending, then the product.
-- p_rows = [{"variant_id":1,"color":"…","is_active":true}] (non-commercial fields only in this reference)
CREATE OR REPLACE FUNCTION aq_edit_variants(p_product INT, p_rows JSONB) RETURNS void AS $$
DECLARE r RECORD;
BEGIN
  PERFORM 1 FROM product_variants WHERE product_id = p_product ORDER BY id FOR NO KEY UPDATE;
  FOR r IN SELECT * FROM jsonb_to_recordset(p_rows) AS x(variant_id INT, color TEXT, is_active BOOLEAN) ORDER BY variant_id LOOP
    UPDATE product_variants SET color = COALESCE(r.color, color), is_active = COALESCE(r.is_active, is_active), version = version + 1
     WHERE id = r.variant_id AND product_id = p_product;
  END LOOP;
  PERFORM aq_refresh_products(ARRAY[p_product]);
END $$ LANGUAGE plpgsql;

-- Search worker: drains the append-only queue; locks products in ascending id order.
CREATE OR REPLACE FUNCTION aq_process_search_queue(p_limit INT DEFAULT 500) RETURNS INT AS $$
DECLARE pid INT; n INT := 0;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _sq (product_id INT) ON COMMIT DROP;
  WITH q AS (DELETE FROM search_reindex_queue WHERE id IN (
               SELECT id FROM search_reindex_queue ORDER BY id LIMIT p_limit FOR UPDATE SKIP LOCKED)
             RETURNING product_id)
  INSERT INTO _sq SELECT product_id FROM q;
  FOR pid IN SELECT DISTINCT product_id FROM _sq ORDER BY 1 LOOP
    -- Lock first, compute in a LATER statement: under READ COMMITTED the computing statement then sees every
    -- change committed before the lock was granted. (Computing inside the waiting UPDATE would reuse an older
    -- snapshot after the wait and could overwrite a newer vector.)
    PERFORM 1 FROM products WHERE id = pid FOR NO KEY UPDATE;
    UPDATE products p SET search_vector = product_search_vector(p) WHERE id = pid;
    n := n + 1;
  END LOOP;
  DELETE FROM _sq;
  RETURN n;
END $$ LANGUAGE plpgsql;

-- ── Coupons ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION aq_reserve_coupon(p_order INT, p_coupon INT, p_user INT, p_email TEXT, p_phone TEXT, p_discount INT)
RETURNS void AS $$
DECLARE c RECORD; used INT;
BEGIN
  SELECT * INTO c FROM coupons WHERE id = p_coupon FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT c.is_active OR c.deleted_at IS NOT NULL
     OR (c.starts_at IS NOT NULL AND c.starts_at > now()) OR (c.ends_at IS NOT NULL AND c.ends_at <= now()) THEN
    RAISE EXCEPTION 'COUPON_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO used FROM coupon_redemptions
   WHERE coupon_id = p_coupon AND status IN ('RESERVED','REDEEMED') AND NOT over_limit
     AND ((p_user IS NOT NULL AND user_id = p_user) OR customer_email = p_email::citext);   -- citext = text would compare case-sensitively
  IF c.usage_limit_per_customer IS NOT NULL AND used >= c.usage_limit_per_customer THEN
    RAISE EXCEPTION 'COUPON_USAGE_EXCEEDED:customer' USING ERRCODE = 'P0001';
  END IF;
  UPDATE coupons SET reserved_count = reserved_count + 1
   WHERE id = p_coupon AND (usage_limit_total IS NULL OR reserved_count + redeemed_count < usage_limit_total);
  IF NOT FOUND THEN RAISE EXCEPTION 'COUPON_USAGE_EXCEEDED:total' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO coupon_redemptions (coupon_id, order_id, user_id, customer_email, customer_phone, discount, status)
  VALUES (p_coupon, p_order, p_user, p_email, p_phone, p_discount, 'RESERVED');
END $$ LANGUAGE plpgsql;

-- ── Order payment-state reassessment ─────────────────────────────────────
-- payment_status PROCESSING is DERIVED: an unpaid order is PROCESSING only while an authorized, not-yet-allocated
-- payment exists. Whenever a payment for an unpaid order resolves without funding it (VOID, HELD), the order is
-- reassessed under its lock and returns to UNPAID, so the normal expiry releases stock and coupon exactly once.
-- Provider-unknown attempts never set PROCESSING; the expiry job's pre-expiry provider check covers them.
CREATE OR REPLACE FUNCTION aq_reassess_order_payment(p_order INT, p_actor TEXT) RETURNS TEXT AS $$
DECLARE o RECORD; n INT;
BEGIN
  SELECT id, status, payment_status INTO o FROM orders WHERE id = p_order FOR NO KEY UPDATE;
  IF o.status <> 'PENDING_PAYMENT' OR o.payment_status <> 'PROCESSING' THEN RETURN 'UNCHANGED'; END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE order_id = p_order AND allocation = 'APPLIED') THEN
    RAISE EXCEPTION 'INVARIANT: order % is PENDING_PAYMENT with an APPLIED payment', p_order;
  END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE order_id = p_order AND allocation IS NULL AND status = 'AUTHORIZED') THEN
    RETURN 'PROCESSING';
  END IF;
  UPDATE orders SET payment_status = 'UNPAID', version = version + 1
   WHERE id = p_order AND status = 'PENDING_PAYMENT' AND payment_status = 'PROCESSING';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN PERFORM aq_history(p_order, 'PAYMENT', 'PROCESSING', 'UNPAID', p_actor, 'no live authorization remains'); END IF;
  RETURN 'UNPAID';
END $$ LANGUAGE plpgsql;

-- ── Payment application (verify, webhook and reconciliation all call this) ─────
-- Inputs come from a provider FETCH made before the transaction (never from the browser):
-- order_id, payment id, amount, currency, status and amount_refunded of the Razorpay payment entity.
-- Returns: UNLINKED | CONFLICT | NOT_CAPTURED | AUTHORIZED | DUPLICATE | APPLIED | EXCESS | LATE | HELD | VOID
--
-- Capture history (status_rank >= 3: captured or refunded) is separate from ELIGIBILITY TO FUND an order:
-- only a captured payment with no provider refunds may fund. A payment first seen already (partially) refunded
-- never initiates fulfilment: fully refunded → VOID; partially refunded → HELD (no funding policy; review).
CREATE OR REPLACE FUNCTION aq_apply_provider_payment(
  p_provider_order_id TEXT, p_payment_id TEXT, p_amount INT, p_currency TEXT, p_status TEXT, p_amount_refunded INT,
  p_captured_at TIMESTAMPTZ, p_method TEXT, p_raw JSONB, p_actor TEXT)
RETURNS TEXT AS $$
DECLARE
  att RECORD; o RECORD; pay RECORD; red RECORD; c RECORD; it RECORD;
  v_rank INT; v_refunded INT; v_alloc TEXT; v_refund INT; n INT; v_recovered BOOLEAN := FALSE;
BEGIN
  v_rank := CASE p_status WHEN 'CREATED' THEN 0 WHEN 'FAILED' THEN 1 WHEN 'AUTHORIZED' THEN 2
                          WHEN 'CAPTURED' THEN 3 WHEN 'REFUNDED' THEN 4 END;
  IF v_rank IS NULL THEN RAISE EXCEPTION 'unknown provider status %', p_status; END IF;
  IF p_amount_refunded IS NULL OR p_amount_refunded < 0 OR p_amount_refunded > p_amount THEN
    RAISE EXCEPTION 'invalid provider amount_refunded % for amount %', p_amount_refunded, p_amount;
  END IF;
  -- Razorpay status "refunded" means fully refunded; take the larger figure if the entity is inconsistent.
  v_refunded := CASE WHEN p_status = 'REFUNDED' THEN p_amount ELSE p_amount_refunded END;

  -- 1. Bind payment → provider order → ArtQ order via the STORED attempt.
  SELECT id, order_id, amount, currency INTO att FROM payment_attempts WHERE provider_order_id = p_provider_order_id;
  IF NOT FOUND THEN
    -- No mapping (yet): record the payment as UNLINKED, never attach it to any order.
    INSERT INTO payments (provider_payment_id, provider_order_id, method, amount, currency, status, status_rank,
                          provider_amount_refunded, allocation, allocated_at, captured_at, raw, updated_at)
    VALUES (p_payment_id, p_provider_order_id, p_method, p_amount, p_currency, p_status::"ProviderPaymentStatus", v_rank,
            v_refunded, 'UNLINKED', now(), p_captured_at, p_raw, now())
    ON CONFLICT (provider_payment_id) DO UPDATE
       SET status = CASE WHEN EXCLUDED.status_rank > payments.status_rank THEN EXCLUDED.status ELSE payments.status END,
           status_rank = GREATEST(payments.status_rank, EXCLUDED.status_rank),
           provider_amount_refunded = GREATEST(payments.provider_amount_refunded, EXCLUDED.provider_amount_refunded),
           captured_at = COALESCE(payments.captured_at, EXCLUDED.captured_at), updated_at = now()
     WHERE payments.provider_order_id = EXCLUDED.provider_order_id
       AND payments.amount = EXCLUDED.amount AND payments.currency = EXCLUDED.currency;
    SELECT * INTO pay FROM payments WHERE provider_payment_id = p_payment_id;
    IF pay.provider_order_id <> p_provider_order_id OR pay.amount <> p_amount OR pay.currency <> p_currency THEN
      PERFORM aq_raise_exception('PAYMENT_IDENTITY_CONFLICT', 'PAYMENT_IDENTITY_CONFLICT:' || p_payment_id || ':' || p_provider_order_id,
                                 pay.order_id, pay.id, NULL, p_amount, jsonb_build_object('reported_provider_order_id', p_provider_order_id,
                                 'stored_provider_order_id', pay.provider_order_id, 'reported_amount', p_amount, 'stored_amount', pay.amount));
      RETURN 'CONFLICT';
    END IF;
    IF pay.allocation = 'UNLINKED' THEN
      PERFORM aq_raise_exception('UNLINKED_PAYMENT', 'UNLINKED_PAYMENT:' || p_payment_id, NULL, pay.id, NULL, p_amount,
                                 jsonb_build_object('provider_order_id', p_provider_order_id));
      RETURN 'UNLINKED';
    END IF;
    RETURN 'DUPLICATE';
  END IF;

  -- 2. Order lock first (lock order §4.1); every decision below is made under it.
  SELECT * INTO o FROM orders WHERE id = att.order_id FOR NO KEY UPDATE;

  -- 3. Monotonic upsert. Identity (provider order, amount, currency) is never overwritten; status and
  --    provider_amount_refunded only move forward; order_id/attempt_id are set only on insert or by step 5.
  INSERT INTO payments (order_id, attempt_id, provider_payment_id, provider_order_id, method, amount, currency,
                        status, status_rank, provider_amount_refunded, captured_at, raw, updated_at)
  VALUES (o.id, att.id, p_payment_id, p_provider_order_id, p_method, p_amount, p_currency,
          p_status::"ProviderPaymentStatus", v_rank, v_refunded, p_captured_at, p_raw, now())
  ON CONFLICT (provider_payment_id) DO UPDATE
     SET status = CASE WHEN EXCLUDED.status_rank > payments.status_rank THEN EXCLUDED.status ELSE payments.status END,
         status_rank = GREATEST(payments.status_rank, EXCLUDED.status_rank),
         provider_amount_refunded = GREATEST(payments.provider_amount_refunded, EXCLUDED.provider_amount_refunded),
         captured_at = COALESCE(payments.captured_at, EXCLUDED.captured_at),
         raw = CASE WHEN EXCLUDED.status_rank >= payments.status_rank THEN EXCLUDED.raw ELSE payments.raw END,
         updated_at = now()
   WHERE payments.provider_order_id = EXCLUDED.provider_order_id
     AND payments.amount = EXCLUDED.amount AND payments.currency = EXCLUDED.currency
     AND (EXCLUDED.status_rank > payments.status_rank OR EXCLUDED.provider_amount_refunded > payments.provider_amount_refunded);
  SELECT * INTO pay FROM payments WHERE provider_payment_id = p_payment_id FOR NO KEY UPDATE;

  -- 4. Identity check: a payment can never be attached to an order other than the one its stored
  --    provider order maps to, nor change amount/currency.
  IF pay.provider_order_id <> p_provider_order_id OR pay.amount <> p_amount OR pay.currency <> p_currency
     OR (pay.order_id IS NOT NULL AND pay.order_id <> o.id) THEN
    PERFORM aq_raise_exception('PAYMENT_IDENTITY_CONFLICT', 'PAYMENT_IDENTITY_CONFLICT:' || p_payment_id || ':' || p_provider_order_id,
                               o.id, pay.id, NULL, p_amount, jsonb_build_object('reported_provider_order_id', p_provider_order_id,
                               'stored_provider_order_id', pay.provider_order_id, 'stored_order_id', pay.order_id,
                               'reported_amount', p_amount, 'stored_amount', pay.amount));
    RETURN 'CONFLICT';
  END IF;

  -- 5. Recovery transition UNLINKED → (bound, allocation NULL). Gated: exactly one caller performs it.
  IF pay.allocation = 'UNLINKED' THEN
    UPDATE payments SET order_id = o.id, attempt_id = att.id, allocation = NULL, allocated_at = NULL, updated_at = now()
     WHERE id = pay.id AND allocation = 'UNLINKED' AND order_id IS NULL AND provider_order_id = p_provider_order_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RETURN 'DUPLICATE'; END IF;
    v_recovered := TRUE;
    SELECT * INTO pay FROM payments WHERE id = pay.id;
  END IF;

  -- 6. Not captured yet: at most a first-time UNPAID → PROCESSING indicator.
  IF pay.status_rank < 3 THEN
    IF v_recovered THEN
      UPDATE payment_exceptions SET status = 'RESOLVED', resolved_at = now(), order_id = o.id, payment_id = pay.id,
             resolution = 'Recovered: bound to order ' || o.order_number || ' (not captured yet)'
       WHERE dedupe_key = 'UNLINKED_PAYMENT:' || p_payment_id AND status <> 'RESOLVED';
    END IF;
    IF pay.status = 'AUTHORIZED' THEN
      UPDATE orders SET payment_status = 'PROCESSING' WHERE id = o.id AND status = 'PENDING_PAYMENT' AND payment_status = 'UNPAID';
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n = 1 THEN PERFORM aq_history(o.id, 'PAYMENT', 'UNPAID', 'PROCESSING', p_actor); END IF;
      RETURN 'AUTHORIZED';
    END IF;
    RETURN 'NOT_CAPTURED';
  END IF;

  -- 7. THE GATE: a captured payment is allocated exactly once. Later observations only reconcile refunds.
  IF pay.allocation IS NOT NULL THEN
    IF pay.provider_amount_refunded > pay.refund_reserved THEN
      -- Money refunded at the provider that the ArtQ ledger does not account for (e.g. dashboard refund):
      -- surface for review; never auto-adjust order totals or create another refund.
      PERFORM aq_raise_exception('RECON_MISMATCH', 'REFUND_RECON:' || p_payment_id || ':' || pay.provider_amount_refunded,
                                 o.id, pay.id, NULL, pay.provider_amount_refunded - pay.refund_reserved,
                                 jsonb_build_object('provider_amount_refunded', pay.provider_amount_refunded,
                                                    'ledger_refund_reserved', pay.refund_reserved, 'allocation', pay.allocation));
    END IF;
    RETURN 'DUPLICATE';
  END IF;

  -- 8. Allocation decision (under the order lock). Eligibility to fund is checked before anything else.
  IF pay.amount <> att.amount OR pay.currency <> att.currency THEN
    v_alloc := 'HELD';
  ELSIF pay.provider_amount_refunded >= pay.amount THEN
    v_alloc := 'VOID';                 -- captured and fully refunded before ArtQ applied it: funds nothing
  ELSIF pay.provider_amount_refunded > 0 THEN
    v_alloc := 'HELD';                 -- partially refunded before apply: no funding policy ⇒ review
  ELSIF EXISTS (SELECT 1 FROM payments x WHERE x.order_id = o.id AND x.allocation = 'APPLIED' AND x.id <> pay.id) THEN
    v_alloc := 'EXCESS';               -- order already funded, whatever its later refund state
  ELSIF o.payment_method = 'RAZORPAY' AND o.status = 'PENDING_PAYMENT' THEN
    v_alloc := 'APPLIED';
  ELSIF o.payment_method = 'RAZORPAY' AND o.status = 'EXPIRED' THEN
    v_alloc := CASE WHEN aq_reacquire_order(o.id) THEN 'APPLIED' ELSE 'LATE' END;
  ELSIF o.status = 'CANCELLED' THEN
    v_alloc := 'LATE';
  ELSE
    v_alloc := 'HELD';                 -- unexpected (e.g. COD order); manual review
  END IF;

  UPDATE payments SET allocation = v_alloc::"PaymentAllocation", allocated_at = now()
   WHERE id = pay.id AND allocation IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN 'DUPLICATE'; END IF;

  IF v_recovered THEN
    UPDATE payment_exceptions SET status = 'RESOLVED', resolved_at = now(), order_id = o.id, payment_id = pay.id,
           resolution = 'Recovered: bound to order ' || o.order_number || ', allocation ' || v_alloc
     WHERE dedupe_key = 'UNLINKED_PAYMENT:' || p_payment_id AND status <> 'RESOLVED';
  END IF;

  -- 9. Money already refunded at the provider before allocation: record it once as a PROCESSED
  --    PROVIDER_INITIATED refund so payment capacity can never refund the same money again.
  IF pay.provider_amount_refunded > 0 THEN
    INSERT INTO refunds (order_id, payment_id, kind, method, status, amount, unallocated_amount, reason,
                         idempotency_key, processed_at, updated_at)
    VALUES (o.id, pay.id, 'PROVIDER_INITIATED', 'ORIGINAL_PAYMENT', 'PROCESSED', pay.provider_amount_refunded,
            pay.provider_amount_refunded, 'Refunded at the provider before ArtQ applied the payment',
            'provider-refunded-' || p_payment_id, now(), now());
    UPDATE payments SET refund_reserved = refund_reserved + pay.provider_amount_refunded,
                        amount_refunded = amount_refunded + pay.provider_amount_refunded
     WHERE id = pay.id AND refund_reserved + pay.provider_amount_refunded <= amount;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'INVARIANT: provider refund exceeds payment % capacity', pay.id; END IF;
    PERFORM aq_raise_exception('REFUNDED_BEFORE_APPLY', 'REFUNDED_BEFORE_APPLY:' || p_payment_id, o.id, pay.id, NULL,
                               pay.provider_amount_refunded, jsonb_build_object('amount', pay.amount,
                               'provider_amount_refunded', pay.provider_amount_refunded, 'allocation', v_alloc));
    IF v_alloc = 'VOID' THEN
      UPDATE payment_exceptions SET status = 'RESOLVED', resolved_at = now(),
             resolution = 'Fully refunded at the provider; no funds held; order not funded'
       WHERE dedupe_key = 'REFUNDED_BEFORE_APPLY:' || p_payment_id;
    END IF;
  END IF;

  -- 10. Side effects, each gated by its own transition.
  IF v_alloc = 'APPLIED' THEN
    UPDATE orders SET status = 'PLACED', payment_status = 'PAID', captured_amount = captured_amount + pay.amount,
           placed_at = now(), expires_at = NULL, expired_at = NULL, version = version + 1
     WHERE id = o.id AND status IN ('PENDING_PAYMENT','EXPIRED') AND captured_amount = 0;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'INVARIANT: order % could not transition to PLACED', o.id; END IF;
    UPDATE payment_attempts SET status = 'PAID' WHERE id = att.id;

    FOR it IN SELECT product_id, sum(quantity)::INT AS q FROM order_items WHERE order_id = o.id GROUP BY product_id ORDER BY product_id LOOP
      UPDATE products SET sold_count = sold_count + it.q WHERE id = it.product_id;
    END LOOP;

    SELECT * INTO red FROM coupon_redemptions WHERE order_id = o.id AND status IN ('RESERVED','RELEASED');
    IF FOUND THEN
      SELECT * INTO c FROM coupons WHERE id = red.coupon_id FOR NO KEY UPDATE;
      IF red.status = 'RESERVED' THEN
        UPDATE coupon_redemptions SET status = 'REDEEMED', redeemed_at = now() WHERE id = red.id AND status = 'RESERVED';
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n = 1 AND NOT red.over_limit THEN
          UPDATE coupons SET reserved_count = reserved_count - 1, redeemed_count = redeemed_count + 1 WHERE id = c.id;
        END IF;
      ELSE
        UPDATE coupons SET redeemed_count = redeemed_count + 1
         WHERE id = c.id AND (usage_limit_total IS NULL OR reserved_count + redeemed_count < usage_limit_total);
        GET DIAGNOSTICS n = ROW_COUNT;
        UPDATE coupon_redemptions SET status = 'REDEEMED', redeemed_at = now(), over_limit = (n = 0)
         WHERE id = red.id AND status = 'RELEASED';
        IF n = 0 THEN
          PERFORM aq_raise_exception('COUPON_OVER_LIMIT', 'COUPON_OVER_LIMIT:' || o.id, o.id, pay.id, NULL, red.discount, NULL);
        END IF;
      END IF;
    END IF;

    UPDATE carts SET status = 'CONVERTED' WHERE id = o.cart_id AND status = 'ACTIVE';
    PERFORM aq_history(o.id, 'ORDER', o.status::TEXT, 'PLACED', p_actor);
    PERFORM aq_history(o.id, 'PAYMENT', o.payment_status::TEXT, 'PAID', p_actor);
    PERFORM aq_emit('order', o.order_number, 'order.placed', jsonb_build_object('order_id', o.id, 'late', o.status = 'EXPIRED'),
                    ARRAY['email.customer','email.admin','notify.admin']);
    RETURN 'APPLIED';
  END IF;

  IF v_alloc IN ('EXCESS','LATE') THEN
    PERFORM aq_raise_exception(CASE WHEN v_alloc = 'EXCESS' THEN 'EXCESS_CAPTURE'
                                    WHEN o.status = 'CANCELLED' THEN 'LATE_CAPTURE_CANCELLED' ELSE 'LATE_CAPTURE_EXPIRED' END,
                               v_alloc || '_CAPTURE:' || p_payment_id, o.id, pay.id, NULL, pay.amount, NULL);
    v_refund := aq_request_refund(o.id, pay.id, CASE WHEN v_alloc = 'EXCESS' THEN 'EXCESS_CAPTURE' ELSE 'LATE_CAPTURE' END,
                                  '[]'::JSONB, 0, 0, pay.amount, 'Automatic: ' || lower(v_alloc) || ' capture',
                                  'auto-' || lower(v_alloc) || '-' || p_payment_id, NULL);
    PERFORM aq_emit('order', o.order_number, 'payment.refund_notice', jsonb_build_object('order_id', o.id, 'reason', v_alloc),
                    ARRAY['email.customer']);
    RETURN v_alloc;
  END IF;

  IF v_alloc = 'VOID' THEN
    PERFORM aq_reassess_order_payment(o.id, p_actor);   -- AUTHORIZED → refunded must not leave the order PROCESSING
    RETURN 'VOID';                     -- no inventory, coupon or outbox effects; at most PROCESSING → UNPAID
  END IF;

  -- HELD: amount/currency mismatch, partially refunded before apply, or unexpected order state.
  IF pay.amount <> att.amount OR pay.currency <> att.currency THEN
    PERFORM aq_raise_exception(CASE WHEN pay.currency <> att.currency THEN 'CURRENCY_MISMATCH' ELSE 'AMOUNT_MISMATCH' END,
                               'HELD:' || p_payment_id, o.id, pay.id, NULL, pay.amount,
                               jsonb_build_object('expected', att.amount, 'received', pay.amount, 'order_status', o.status));
  ELSIF pay.provider_amount_refunded = 0 THEN
    PERFORM aq_raise_exception('AMOUNT_MISMATCH', 'HELD:' || p_payment_id, o.id, pay.id, NULL, pay.amount,
                               jsonb_build_object('reason', 'unexpected order state', 'order_status', o.status,
                                                  'payment_method', o.payment_method));
  END IF;
  PERFORM aq_reassess_order_payment(o.id, p_actor);
  RETURN 'HELD';
END $$ LANGUAGE plpgsql;

-- ── Refund capacity ─────────────────────────────────────────────────────
-- Counted allocations: REQUESTED, PENDING, UNKNOWN, PROCESSED. FAILED and CANCELLED release.
-- Item, shipping, COD-fee and order capacity apply to order-funded refunds; EXCESS/LATE refunds
-- (unallocated_amount) are capped by their own payment row only. Payment cap applies to every online refund.
CREATE OR REPLACE FUNCTION aq_refund_capacity(p_refund INT, p_sign INT) RETURNS void AS $$
DECLARE rf RECORD; it RECORD; n INT; order_part INT;
BEGIN
  SELECT * INTO rf FROM refunds WHERE id = p_refund;
  order_part := rf.items_amount + rf.shipping_amount + rf.cod_fee_amount;
  FOR it IN SELECT order_item_id, quantity, amount FROM refund_items WHERE refund_id = p_refund ORDER BY order_item_id LOOP
    UPDATE order_items
       SET refund_reserved_qty = refund_reserved_qty + p_sign * it.quantity,
           refund_reserved_amount = refund_reserved_amount + p_sign * it.amount
     WHERE id = it.order_item_id AND order_id = rf.order_id
       AND refund_reserved_qty + p_sign * it.quantity BETWEEN refunded_qty AND quantity
       AND refund_reserved_amount + p_sign * it.amount BETWEEN refunded_amount AND net_amount;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE EXCEPTION 'REFUND_EXCEEDS_CAPACITY:item:%', it.order_item_id USING ERRCODE = 'P0001'; END IF;
  END LOOP;
  IF order_part > 0 THEN
    UPDATE orders
       SET refund_reserved_total = refund_reserved_total + p_sign * order_part,
           refund_reserved_shipping = refund_reserved_shipping + p_sign * rf.shipping_amount,
           refund_reserved_cod_fee = refund_reserved_cod_fee + p_sign * rf.cod_fee_amount
     WHERE id = rf.order_id
       AND refund_reserved_total + p_sign * order_part
           BETWEEN refunded_amount AND CASE WHEN payment_method = 'COD' THEN total ELSE captured_amount END
       AND refund_reserved_shipping + p_sign * rf.shipping_amount BETWEEN 0 AND shipping_fee
       AND refund_reserved_cod_fee + p_sign * rf.cod_fee_amount BETWEEN 0 AND cod_fee;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE EXCEPTION 'REFUND_EXCEEDS_CAPACITY:order' USING ERRCODE = 'P0001'; END IF;
  END IF;
  IF rf.payment_id IS NOT NULL AND p_sign > 0 THEN
    -- Reconciliation gate: if the provider reports more refunded than the ledger accounts for (refunds made
    -- outside ArtQ, not yet reconciled), no new refund or retry may reserve capacity on this payment.
    PERFORM 1 FROM payments WHERE id = rf.payment_id AND provider_amount_refunded > refund_reserved;
    IF FOUND THEN RAISE EXCEPTION 'REFUND_RECONCILIATION_REQUIRED:payment' USING ERRCODE = 'P0001'; END IF;
  END IF;
  IF rf.payment_id IS NOT NULL THEN
    UPDATE payments SET refund_reserved = refund_reserved + p_sign * rf.amount
     WHERE id = rf.payment_id AND refund_reserved + p_sign * rf.amount BETWEEN amount_refunded AND amount;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE EXCEPTION 'REFUND_EXCEEDS_CAPACITY:payment' USING ERRCODE = 'P0001'; END IF;
  END IF;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aq_new_refund_attempt(p_refund INT) RETURNS INT AS $$
DECLARE rf RECORD; pr RECORD; a INT;
BEGIN
  SELECT * INTO rf FROM refunds WHERE id = p_refund;
  IF rf.method <> 'ORIGINAL_PAYMENT' THEN RETURN NULL; END IF;
  SELECT provider_payment_id INTO pr FROM payments WHERE id = rf.payment_id;
  INSERT INTO refund_attempts (refund_id, attempt_no, provider_idempotency_key, receipt, request, updated_at)
  VALUES (rf.id, rf.attempt_no,
          'artq-refund-' || rf.id || '-a' || rf.attempt_no,                 -- X-Refund-Idempotency (≥10 chars, [A-Za-z0-9_-])
          'AQR_' || rf.id || '_A' || rf.attempt_no,                          -- receipt: correlation for reconciliation
          jsonb_build_object('payment_id', pr.provider_payment_id, 'amount', rf.amount, 'speed', 'normal',
                             'receipt', 'AQR_' || rf.id || '_A' || rf.attempt_no,
                             'notes', jsonb_build_object('aq_refund_id', rf.id, 'aq_attempt', rf.attempt_no)),
          now())
  RETURNING id INTO a;
  PERFORM aq_emit('refund', rf.id::TEXT, 'refund.requested', jsonb_build_object('refund_attempt_id', a), ARRAY['refund.send']);
  RETURN a;
END $$ LANGUAGE plpgsql;

-- Create a refund and reserve capacity atomically. Lock order: order → payment → (order-owned rows).
-- p_items = [{"order_item_id":1,"quantity":1,"amount":45000,"tax_amount":6864}]
CREATE OR REPLACE FUNCTION aq_request_refund(p_order INT, p_payment INT, p_kind TEXT, p_items JSONB,
  p_shipping INT, p_cod_fee INT, p_unallocated INT, p_reason TEXT, p_idem_key TEXT, p_requested_by INT)
RETURNS INT AS $$
DECLARE o RECORD; pay RECORD; v_items INT; v_total INT; v_method TEXT; rid INT;
BEGIN
  SELECT * INTO o FROM orders WHERE id = p_order FOR NO KEY UPDATE;
  IF p_payment IS NOT NULL THEN
    SELECT * INTO pay FROM payments WHERE id = p_payment AND order_id = p_order FOR NO KEY UPDATE;
    IF NOT FOUND OR pay.status_rank < 3 THEN RAISE EXCEPTION 'REFUND_PAYMENT_INVALID' USING ERRCODE = 'P0001'; END IF;
    IF (p_kind IN ('EXCESS_CAPTURE','LATE_CAPTURE')) <> (pay.allocation IN ('EXCESS','LATE','HELD','VOID')) THEN
      RAISE EXCEPTION 'REFUND_PAYMENT_INVALID:allocation' USING ERRCODE = 'P0001';
    END IF;
    v_method := 'ORIGINAL_PAYMENT';
  ELSE
    IF o.payment_method <> 'COD' OR o.payment_status NOT IN ('COD_COLLECTED','COD_REMITTED','PARTIALLY_REFUNDED') THEN
      RAISE EXCEPTION 'REFUND_PAYMENT_INVALID:cod' USING ERRCODE = 'P0001';
    END IF;
    v_method := 'MANUAL_BANK';
  END IF;
  SELECT COALESCE(sum((x->>'amount')::INT), 0) INTO v_items FROM jsonb_array_elements(p_items) x;
  v_total := v_items + p_shipping + p_cod_fee + p_unallocated;
  IF v_total <= 0 THEN RAISE EXCEPTION 'REFUND_AMOUNT_INVALID' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO refunds (order_id, payment_id, kind, method, status, amount, items_amount, shipping_amount, cod_fee_amount,
                       unallocated_amount, reason, idempotency_key, requested_by, updated_at)
  VALUES (p_order, p_payment, p_kind::"RefundKind", v_method::"RefundMethod", 'REQUESTED', v_total, v_items, p_shipping, p_cod_fee,
          p_unallocated, p_reason, p_idem_key, p_requested_by, now())
  RETURNING id INTO rid;
  INSERT INTO refund_items (refund_id, order_item_id, quantity, amount, tax_amount)
  SELECT rid, (x->>'order_item_id')::INT, (x->>'quantity')::INT, (x->>'amount')::INT, COALESCE((x->>'tax_amount')::INT, 0)
    FROM jsonb_array_elements(p_items) x;
  PERFORM aq_refund_capacity(rid, 1);            -- raises ⇒ whole transaction rolls back
  PERFORM aq_new_refund_attempt(rid);            -- online refunds only
  RETURN rid;
END $$ LANGUAGE plpgsql;

-- Retry a FAILED refund: reacquire ALL capacity first, then a NEW provider attempt (new key + receipt).
CREATE OR REPLACE FUNCTION aq_retry_refund(p_refund INT) RETURNS INT AS $$
DECLARE rf RECORD;
BEGIN
  SELECT order_id, payment_id INTO rf FROM refunds WHERE id = p_refund;
  PERFORM 1 FROM orders WHERE id = rf.order_id FOR NO KEY UPDATE;
  IF rf.payment_id IS NOT NULL THEN PERFORM 1 FROM payments WHERE id = rf.payment_id FOR NO KEY UPDATE; END IF;
  UPDATE refunds SET status = 'REQUESTED', attempt_no = attempt_no + 1, failure_reason = NULL, updated_at = now()
   WHERE id = p_refund AND status = 'FAILED';
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_RETRYABLE' USING ERRCODE = 'P0001'; END IF;
  PERFORM aq_refund_capacity(p_refund, 1);       -- fails if a newer refund consumed the capacity
  PERFORM aq_new_refund_attempt(p_refund);
  RETURN (SELECT attempt_no FROM refunds WHERE id = p_refund);
END $$ LANGUAGE plpgsql;

-- Record a provider-call outcome for one attempt (refund.send consumer / reconciler).
-- p_outcome: ACCEPTED_PENDING | ACCEPTED_PROCESSED | UNKNOWN | IN_PROGRESS | FAILED | MISMATCH
CREATE OR REPLACE FUNCTION aq_refund_attempt_result(p_attempt INT, p_outcome TEXT, p_http INT, p_response JSONB, p_provider_refund_id TEXT)
RETURNS TEXT AS $$
DECLARE a RECORD; rf RECORD; n INT;
BEGIN
  SELECT * INTO a FROM refund_attempts WHERE id = p_attempt;
  SELECT * INTO rf FROM refunds WHERE id = a.refund_id;
  PERFORM 1 FROM orders WHERE id = rf.order_id FOR NO KEY UPDATE;
  IF rf.payment_id IS NOT NULL THEN PERFORM 1 FROM payments WHERE id = rf.payment_id FOR NO KEY UPDATE; END IF;
  SELECT * INTO rf FROM refunds WHERE id = a.refund_id FOR NO KEY UPDATE;
  IF rf.attempt_no <> a.attempt_no OR rf.status IN ('PROCESSED','FAILED','CANCELLED') THEN RETURN 'STALE'; END IF;
  UPDATE refund_attempts SET send_count = send_count + 1, last_http_status = p_http, response = p_response,
         provider_refund_id = COALESCE(p_provider_refund_id, provider_refund_id),
         status = (CASE p_outcome WHEN 'ACCEPTED_PENDING' THEN 'ACCEPTED' WHEN 'ACCEPTED_PROCESSED' THEN 'ACCEPTED'
                                  WHEN 'FAILED' THEN 'FAILED' WHEN 'MISMATCH' THEN 'MISMATCH' ELSE 'UNKNOWN' END)::"RefundAttemptStatus",
         updated_at = now()
   WHERE id = a.id;
  IF p_outcome IN ('ACCEPTED_PENDING','ACCEPTED_PROCESSED') THEN
    UPDATE refunds SET status = 'PENDING', provider_refund_id = p_provider_refund_id, sent_at = COALESCE(sent_at, now())
     WHERE id = rf.id AND status IN ('REQUESTED','UNKNOWN');
    IF p_outcome = 'ACCEPTED_PROCESSED' THEN RETURN aq_mark_refund_processed(rf.id, p_provider_refund_id); END IF;
    RETURN 'PENDING';
  ELSIF p_outcome IN ('UNKNOWN','IN_PROGRESS') THEN
    UPDATE refunds SET status = 'UNKNOWN' WHERE id = rf.id AND status IN ('REQUESTED','UNKNOWN');
    RETURN 'UNKNOWN';                              -- resend SAME key + SAME request later, or reconcile by receipt
  ELSIF p_outcome = 'MISMATCH' THEN
    UPDATE refunds SET status = 'UNKNOWN' WHERE id = rf.id;   -- capacity stays reserved until a human resolves it
    PERFORM aq_raise_exception('REFUND_IDEMPOTENCY_MISMATCH', 'REFUND_IDEMPOTENCY_MISMATCH:' || a.id, rf.order_id, rf.payment_id, rf.id, rf.amount, p_response);
    RETURN 'MISMATCH';
  ELSE
    UPDATE refunds SET status = 'FAILED', failure_reason = p_response->>'description' WHERE id = rf.id AND status IN ('REQUESTED','UNKNOWN','PENDING');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 1 THEN
      PERFORM aq_refund_capacity(rf.id, -1);       -- policy: definitive failure releases capacity
      PERFORM aq_raise_exception('REFUND_FAILED', 'REFUND_FAILED:' || rf.id || ':' || a.attempt_no, rf.order_id, rf.payment_id, rf.id, rf.amount, p_response);
    END IF;
    RETURN 'FAILED';
  END IF;
END $$ LANGUAGE plpgsql;

-- PROCESSED (webhook refund.processed, reconciler, or manual COD transfer reference). Gated, once.
CREATE OR REPLACE FUNCTION aq_mark_refund_processed(p_refund INT, p_provider_refund_id TEXT) RETURNS TEXT AS $$
DECLARE rf RECORD; o RECORD; it RECORD; n INT; v_order_part INT;
BEGIN
  SELECT order_id, payment_id INTO rf FROM refunds WHERE id = p_refund;
  SELECT * INTO o FROM orders WHERE id = rf.order_id FOR NO KEY UPDATE;
  IF rf.payment_id IS NOT NULL THEN PERFORM 1 FROM payments WHERE id = rf.payment_id FOR NO KEY UPDATE; END IF;
  UPDATE refunds SET status = 'PROCESSED', processed_at = now(), provider_refund_id = COALESCE(p_provider_refund_id, provider_refund_id)
   WHERE id = p_refund AND status IN ('REQUESTED','PENDING','UNKNOWN')
  RETURNING * INTO rf;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN 'DUPLICATE'; END IF;
  FOR it IN SELECT order_item_id, quantity, amount FROM refund_items WHERE refund_id = p_refund ORDER BY order_item_id LOOP
    UPDATE order_items SET refunded_qty = refunded_qty + it.quantity, refunded_amount = refunded_amount + it.amount WHERE id = it.order_item_id;
  END LOOP;
  v_order_part := rf.items_amount + rf.shipping_amount + rf.cod_fee_amount;
  IF rf.payment_id IS NOT NULL THEN
    UPDATE payments SET amount_refunded = amount_refunded + rf.amount WHERE id = rf.payment_id;
  END IF;
  IF v_order_part > 0 THEN
    UPDATE orders SET refunded_amount = refunded_amount + v_order_part,
           payment_status = (CASE WHEN refunded_amount + v_order_part >= CASE WHEN payment_method = 'COD' THEN total ELSE captured_amount END
                                  THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END)::"OrderPaymentStatus"
     WHERE id = o.id;
    PERFORM aq_history(o.id, 'PAYMENT', o.payment_status::TEXT, (SELECT payment_status::TEXT FROM orders WHERE id = o.id), 'SYSTEM');
  ELSE
    UPDATE payment_exceptions SET status = 'RESOLVED', resolved_at = now(), resolution = 'Automatic refund processed'
     WHERE payment_id = rf.payment_id AND type IN ('EXCESS_CAPTURE','LATE_CAPTURE_EXPIRED','LATE_CAPTURE_CANCELLED') AND status <> 'RESOLVED';
  END IF;
  PERFORM aq_emit('refund', p_refund::TEXT, 'refund.processed', jsonb_build_object('refund_id', p_refund, 'order_id', o.id),
                  ARRAY['email.customer','invoice.credit_note']);
  RETURN 'PROCESSED';
END $$ LANGUAGE plpgsql;

-- Reconcile the provider's refund records for one payment into the ledger (reconciler; after RECON_MISMATCH).
-- p_refunds = GET /payments/{id}/refunds items: [{"id","amount","status","receipt","notes":{"aq_refund_id"}}]
-- ArtQ's own refunds are matched by provider refund id, attempt receipt or notes.aq_refund_id and are never
-- counted as external; processed ones are marked PROCESSED once. Refunds made outside ArtQ are recorded once as
-- PROCESSED PROVIDER_INITIATED refunds (cumulative, idempotent), reducing payment (and, for an APPLIED payment,
-- order) capacity. The refund gate clears only when the ledger explains the provider's refunded total.
CREATE OR REPLACE FUNCTION aq_reconcile_provider_refunds(p_payment INT, p_refunds JSONB) RETURNS TEXT AS $$
DECLARE pay RECORD; o RECORD; r RECORD; ours INT; ours_status TEXT; n INT;
        v_list_total INT := 0; v_external INT := 0; v_recorded INT; v_delta INT; v_ids TEXT := '';
BEGIN
  SELECT order_id INTO pay FROM payments WHERE id = p_payment;
  IF pay.order_id IS NULL THEN RETURN 'UNBOUND'; END IF;              -- UNLINKED: recover first
  SELECT * INTO o FROM orders WHERE id = pay.order_id FOR NO KEY UPDATE;
  SELECT * INTO pay FROM payments WHERE id = p_payment FOR NO KEY UPDATE;
  FOR r IN SELECT x->>'id' AS id, (x->>'amount')::INT AS amount, x->>'status' AS status, x->>'receipt' AS receipt,
                  x->'notes'->>'aq_refund_id' AS aq_refund_id
             FROM jsonb_array_elements(p_refunds) x ORDER BY x->>'id' LOOP
    CONTINUE WHEN r.status = 'failed';
    v_list_total := v_list_total + r.amount;
    SELECT rf.id, rf.status INTO ours, ours_status FROM refunds rf
      LEFT JOIN refund_attempts ra ON ra.refund_id = rf.id
     WHERE rf.payment_id = p_payment AND rf.kind <> 'PROVIDER_INITIATED'
       AND (rf.provider_refund_id = r.id OR ra.provider_refund_id = r.id OR ra.receipt = r.receipt OR rf.id::TEXT = r.aq_refund_id)
     LIMIT 1;
    IF FOUND THEN
      IF r.status = 'processed' AND ours_status IN ('REQUESTED','PENDING','UNKNOWN') THEN
        PERFORM aq_mark_refund_processed(ours, r.id);                  -- gated: once
      ELSE
        UPDATE refunds SET provider_refund_id = r.id WHERE id = ours AND provider_refund_id IS NULL;
      END IF;
    ELSE
      v_external := v_external + r.amount;
      v_ids := v_ids || r.id || ' ';
    END IF;
  END LOOP;
  SELECT COALESCE(sum(amount), 0) INTO v_recorded FROM refunds WHERE payment_id = p_payment AND kind = 'PROVIDER_INITIATED';
  v_delta := v_external - v_recorded;
  IF v_delta < 0 THEN
    PERFORM aq_raise_exception('RECON_MISMATCH', 'REFUND_RECON_NEGATIVE:' || pay.provider_payment_id || ':' || v_external,
                               o.id, p_payment, NULL, -v_delta, jsonb_build_object('external', v_external, 'recorded', v_recorded));
    RETURN 'INCONSISTENT';
  ELSIF v_delta > 0 THEN
    INSERT INTO refunds (order_id, payment_id, kind, method, status, amount, unallocated_amount, reason,
                         idempotency_key, processed_at, updated_at)
    VALUES (o.id, p_payment, 'PROVIDER_INITIATED', 'ORIGINAL_PAYMENT', 'PROCESSED', v_delta, v_delta,
            'Refunded at the provider outside ArtQ: ' || btrim(v_ids),
            'provider-refunds-' || pay.provider_payment_id || '-' || v_external, now(), now());
    UPDATE payments SET refund_reserved = refund_reserved + v_delta, amount_refunded = amount_refunded + v_delta
     WHERE id = p_payment AND refund_reserved + v_delta <= amount;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'INVARIANT: provider refunds exceed payment % capacity', p_payment; END IF;
    IF pay.allocation = 'APPLIED' THEN                                 -- money left an order-funding payment
      UPDATE orders SET refund_reserved_total = refund_reserved_total + v_delta, refunded_amount = refunded_amount + v_delta,
             payment_status = (CASE WHEN refunded_amount + v_delta >= captured_amount THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END)::"OrderPaymentStatus"
       WHERE id = o.id AND refund_reserved_total + v_delta <= captured_amount;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> 1 THEN RAISE EXCEPTION 'INVARIANT: provider refunds exceed order % capacity', o.id; END IF;
      PERFORM aq_history(o.id, 'PAYMENT', o.payment_status::TEXT, (SELECT payment_status::TEXT FROM orders WHERE id = o.id), 'SYSTEM',
                         'refund made outside ArtQ recorded');
    END IF;
    PERFORM aq_raise_exception('REFUNDED_OUTSIDE_ARTQ', 'REFUNDED_OUTSIDE_ARTQ:' || pay.provider_payment_id || ':' || v_external,
                               o.id, p_payment, NULL, v_delta, jsonb_build_object('provider_refund_ids', btrim(v_ids)));
  END IF;
  UPDATE payments SET provider_amount_refunded = GREATEST(provider_amount_refunded, v_list_total) WHERE id = p_payment;
  SELECT * INTO pay FROM payments WHERE id = p_payment;
  IF pay.provider_amount_refunded <= pay.refund_reserved THEN
    UPDATE payment_exceptions SET status = 'RESOLVED', resolved_at = now(), resolution = 'Provider refunds reconciled into the ledger'
     WHERE payment_id = p_payment AND type = 'RECON_MISMATCH' AND dedupe_key LIKE 'REFUND_RECON:%' AND status <> 'RESOLVED';
    RETURN 'RECONCILED';
  END IF;
  RETURN 'STILL_UNEXPLAINED';                                          -- gate stays closed
END $$ LANGUAGE plpgsql;

-- Cancel a MANUAL_BANK (COD) refund that has not been processed. Online refunds cannot be cancelled once
-- requested: a provider call may already be in flight, so their capacity is only released by a FAILED result.
CREATE OR REPLACE FUNCTION aq_cancel_manual_refund(p_refund INT) RETURNS void AS $$
DECLARE rf RECORD; n INT;
BEGIN
  SELECT order_id INTO rf FROM refunds WHERE id = p_refund;
  PERFORM 1 FROM orders WHERE id = rf.order_id FOR NO KEY UPDATE;
  UPDATE refunds SET status = 'CANCELLED', updated_at = now()
   WHERE id = p_refund AND method = 'MANUAL_BANK' AND status = 'REQUESTED';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'REFUND_NOT_CANCELLABLE' USING ERRCODE = 'P0001'; END IF;
  PERFORM aq_refund_capacity(p_refund, -1);
END $$ LANGUAGE plpgsql;

-- ── Webhook inbox leases (fenced) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION aq_webhook_claim(p_id INT, p_lease_s INT DEFAULT 300) RETURNS UUID AS $$
  UPDATE webhook_events SET status = 'PROCESSING', attempts = attempts + 1,
         lease_token = gen_random_uuid(), locked_until = now() + make_interval(secs => p_lease_s)
   WHERE id = p_id AND (status IN ('RECEIVED','FAILED') AND next_attempt_at <= now()
                        OR (status = 'PROCESSING' AND locked_until < now()))
  RETURNING lease_token;
$$ LANGUAGE sql;

-- First statement of the domain transaction: locks the event and proves the lease is still ours.
CREATE OR REPLACE FUNCTION aq_webhook_begin(p_id INT, p_token UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM webhook_events WHERE id = p_id AND status = 'PROCESSING' AND lease_token = p_token FOR NO KEY UPDATE);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION aq_webhook_renew(p_id INT, p_token UUID, p_lease_s INT DEFAULT 300) RETURNS BOOLEAN AS $$
DECLARE n INT;
BEGIN
  UPDATE webhook_events SET locked_until = now() + make_interval(secs => p_lease_s)
   WHERE id = p_id AND status = 'PROCESSING' AND lease_token = p_token;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$ LANGUAGE plpgsql;

-- Same transaction as the domain change; raises if the lease was lost so the domain change rolls back.
CREATE OR REPLACE FUNCTION aq_webhook_complete(p_id INT, p_token UUID, p_final TEXT DEFAULT 'PROCESSED') RETURNS void AS $$
BEGIN
  UPDATE webhook_events SET status = p_final::"WebhookStatus", processed_at = now(), lease_token = NULL, locked_until = NULL, last_error = NULL
   WHERE id = p_id AND status = 'PROCESSING' AND lease_token = p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'LEASE_LOST:webhook:%', p_id USING ERRCODE = 'P0002'; END IF;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aq_webhook_fail(p_id INT, p_token UUID, p_error TEXT) RETURNS TEXT AS $$
DECLARE e RECORD;
BEGIN
  UPDATE webhook_events SET
         status = (CASE WHEN attempts >= 10 THEN 'DEAD' ELSE 'FAILED' END)::"WebhookStatus",
         last_error = p_error, lease_token = NULL, locked_until = NULL,
         next_attempt_at = now() + make_interval(secs => least(3600, 30 * power(2, attempts)::INT))
   WHERE id = p_id AND status = 'PROCESSING' AND lease_token = p_token
  RETURNING id, status INTO e;
  IF NOT FOUND THEN RETURN 'LEASE_LOST'; END IF;           -- a newer worker owns it; do nothing
  IF e.status = 'DEAD' THEN
    PERFORM aq_raise_exception('WEBHOOK_DEAD', 'WEBHOOK_DEAD:' || p_id, NULL, NULL, NULL, NULL, jsonb_build_object('webhook_event_id', p_id));
    UPDATE payment_exceptions SET webhook_event_id = p_id WHERE dedupe_key = 'WEBHOOK_DEAD:' || p_id;
  END IF;
  RETURN e.status::TEXT;
END $$ LANGUAGE plpgsql;

-- ── Outbox deliveries (lease + fencing; no network inside a transaction) ──
-- Claim: short transaction. Eligible: PENDING due, LEASED with expired lease, PUBLISHED but not
-- completed within p_redeliver_s (broker may have lost the job). Rows past p_max_gen become DEAD.
CREATE OR REPLACE FUNCTION aq_outbox_claim(p_limit INT, p_lease_s INT, p_redeliver_s INT, p_max_gen INT)
RETURNS TABLE (delivery_id BIGINT, consumer TEXT, generation INT, lease_token UUID, event_id BIGINT, event_type TEXT, payload JSONB) AS $$
#variable_conflict use_column
DECLARE d RECORD;
BEGIN
  FOR d IN SELECT x.id FROM outbox_deliveries x
            WHERE x.generation >= p_max_gen
              AND ((x.status = 'PENDING' AND x.next_attempt_at <= now())
                   OR (x.status = 'LEASED' AND x.lease_expires_at < now())
                   OR (x.status = 'PUBLISHED' AND x.published_at < now() - make_interval(secs => p_redeliver_s)))
            ORDER BY x.id FOR UPDATE SKIP LOCKED LOOP
    UPDATE outbox_deliveries SET status = 'DEAD', lease_token = NULL, lease_expires_at = NULL WHERE id = d.id;
    PERFORM aq_raise_exception('OUTBOX_DEAD', 'OUTBOX_DEAD:' || d.id, NULL, NULL, NULL, NULL, jsonb_build_object('delivery_id', d.id));
  END LOOP;
  RETURN QUERY
  WITH c AS (
    SELECT x.id FROM outbox_deliveries x
     WHERE (x.status = 'PENDING' AND x.next_attempt_at <= now())
        OR (x.status = 'LEASED' AND x.lease_expires_at < now())
        OR (x.status = 'PUBLISHED' AND x.published_at < now() - make_interval(secs => p_redeliver_s))
     ORDER BY x.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
  UPDATE outbox_deliveries o SET status = 'LEASED', generation = o.generation + 1, lease_token = gen_random_uuid(),
         lease_expires_at = now() + make_interval(secs => p_lease_s)
    FROM c, outbox_events e
   WHERE o.id = c.id AND e.id = o.event_id
  RETURNING o.id, o.consumer::TEXT, o.generation, o.lease_token, e.id, e.event_type::TEXT, e.payload;
END $$ LANGUAGE plpgsql;

-- Broker accepted the job (after queue.add returned). Fenced by lease token.
CREATE OR REPLACE FUNCTION aq_outbox_mark_published(p_id BIGINT, p_token UUID) RETURNS BOOLEAN AS $$
DECLARE n INT;
BEGIN
  UPDATE outbox_deliveries SET status = 'PUBLISHED', published_at = now(), lease_token = NULL, lease_expires_at = NULL
   WHERE id = p_id AND status = 'LEASED' AND lease_token = p_token;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aq_outbox_publish_failed(p_id BIGINT, p_token UUID, p_error TEXT) RETURNS BOOLEAN AS $$
DECLARE n INT;
BEGIN
  UPDATE outbox_deliveries SET status = 'PENDING', lease_token = NULL, lease_expires_at = NULL, last_error = p_error,
         next_attempt_at = now() + make_interval(secs => least(600, 5 * power(2, generation)::INT))
   WHERE id = p_id AND status = 'LEASED' AND lease_token = p_token;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$ LANGUAGE plpgsql;

-- Consumer side, inside the consumer's own transaction:
--   aq_outbox_begin_consume → (apply effect) → aq_outbox_complete. Returns FALSE when already done.
CREATE OR REPLACE FUNCTION aq_outbox_begin_consume(p_id BIGINT) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM outbox_deliveries WHERE id = p_id AND status NOT IN ('COMPLETED','DEAD') FOR NO KEY UPDATE);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION aq_outbox_complete(p_id BIGINT) RETURNS BOOLEAN AS $$
DECLARE n INT;
BEGIN
  UPDATE outbox_deliveries SET status = 'COMPLETED', completed_at = now(), lease_token = NULL, lease_expires_at = NULL
   WHERE id = p_id AND status NOT IN ('COMPLETED','DEAD');
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$ LANGUAGE plpgsql;

-- ── Sessions: audience-specific authorization versions (architecture.md §5.4) ──
-- Storefront sessions compare with users.storefront_auth_version, admin sessions with users.admin_auth_version.
-- Used by the auth middleware on a Redis cache miss (cache key session:<sid>, deleted on every change below).
CREATE OR REPLACE FUNCTION aq_session_valid(p_sid UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = p_sid AND s.revoked_at IS NULL AND s.idle_expires_at > now() AND s.absolute_expires_at > now()
       AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
       AND s.auth_version = CASE s.audience WHEN 'ADMIN' THEN u.admin_auth_version ELSE u.storefront_auth_version END
       AND (s.audience = 'STOREFRONT' OR u.role <> 'CUSTOMER'));
$$ LANGUAGE sql STABLE;

-- Role change: admin authorization only. Storefront sessions of the same person stay valid.
CREATE OR REPLACE FUNCTION aq_change_role(p_user INT, p_role TEXT) RETURNS void AS $$
BEGIN
  UPDATE users SET role = p_role::"UserRole", admin_auth_version = admin_auth_version + 1 WHERE id = p_user;
  UPDATE sessions SET revoked_at = now(), revoke_reason = 'ROLE_CHANGED'
   WHERE user_id = p_user AND audience = 'ADMIN' AND revoked_at IS NULL;
END $$ LANGUAGE plpgsql;

-- Global logout: block, password change/reset, email change, logout-everywhere.
CREATE OR REPLACE FUNCTION aq_revoke_all_sessions(p_user INT, p_reason TEXT, p_block BOOLEAN DEFAULT FALSE) RETURNS void AS $$
BEGIN
  UPDATE users SET storefront_auth_version = storefront_auth_version + 1, admin_auth_version = admin_auth_version + 1,
         status = CASE WHEN p_block THEN 'BLOCKED'::"UserStatus" ELSE status END
   WHERE id = p_user;
  UPDATE sessions SET revoked_at = now(), revoke_reason = p_reason WHERE user_id = p_user AND revoked_at IS NULL;
END $$ LANGUAGE plpgsql;
