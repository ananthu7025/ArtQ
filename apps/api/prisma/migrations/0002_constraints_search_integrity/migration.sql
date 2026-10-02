-- GENERATED from docs/database.md §6 by scripts/db-from-docs.mjs. Do not edit.
-- 0002_constraints_search_integrity.sql
-- Things Prisma cannot express: partial unique indexes, cross-column/table checks,
-- composite FKs, sequences, triggers. Runs right after 0001_init in the same release.

-- ── Partial unique indexes ─────────────────────────────────────────────
CREATE UNIQUE INDEX users_email_live_uq          ON users (email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_phone_verified_uq      ON users (phone) WHERE phone_verified_at IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX variants_sku_live_uq         ON product_variants (sku) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX variants_options_live_uq     ON product_variants (product_id, COALESCE(size,''), COALESCE(color,''), COALESCE(thickness,''))
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX carts_user_active_uq         ON carts (user_id) WHERE status = 'ACTIVE' AND user_id IS NOT NULL;
CREATE UNIQUE INDEX addresses_one_default_uq     ON addresses (user_id) WHERE is_default;
CREATE UNIQUE INDEX product_images_one_cover_uq  ON product_images (product_id) WHERE is_cover;
CREATE UNIQUE INDEX stock_notif_pending_uq       ON stock_notifications (variant_id, email) WHERE status = 'PENDING';
CREATE UNIQUE INDEX reservations_live_uq         ON inventory_reservations (order_item_id) WHERE status IN ('ACTIVE','CONSUMED');
CREATE UNIQUE INDEX orders_one_pending_per_cart_uq ON orders (cart_id) WHERE status = 'PENDING_PAYMENT' AND cart_id IS NOT NULL;
CREATE UNIQUE INDEX attempts_one_open_per_order_uq ON payment_attempts (order_id) WHERE status IN ('CREATING','CREATED','PROVIDER_UNKNOWN');
CREATE UNIQUE INDEX invoices_one_tax_invoice_uq  ON invoices (order_id) WHERE kind = 'TAX_INVOICE';
CREATE UNIQUE INDEX refunds_idempotency_uq       ON refunds (order_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX mfa_recovery_live_uq         ON mfa_recovery_codes (user_id, code_hash) WHERE used_at IS NULL;

-- ── Composite FK: a product's category must belong to the product's type ──
-- (categories has UNIQUE(id, type_id) from 0001)
ALTER TABLE products ADD CONSTRAINT products_category_matches_type_fk
  FOREIGN KEY (category_id, type_id) REFERENCES categories (id, type_id) ON DELETE RESTRICT;

-- ── Catalogue checks ─────────────────────────────────────────────────────
ALTER TABLE products ADD CONSTRAINT products_gst_rate_ck   CHECK (gst_rate IS NULL OR gst_rate BETWEEN 0 AND 40);
ALTER TABLE products ADD CONSTRAINT products_active_gate_ck CHECK (
  status <> 'ACTIVE' OR (is_publishable AND type_id IS NOT NULL AND category_id IS NOT NULL
                         AND hsn_code IS NOT NULL AND gst_rate IS NOT NULL AND tax_approved_at IS NOT NULL
                         AND published_at IS NOT NULL));
ALTER TABLE product_variants ADD CONSTRAINT variants_price_ck   CHECK (price IS NULL OR price > 0);
ALTER TABLE product_variants ADD CONSTRAINT variants_mrp_ck     CHECK (mrp IS NULL OR (price IS NOT NULL AND mrp >= price));
ALTER TABLE product_variants ADD CONSTRAINT variants_cost_ck    CHECK (cost_price IS NULL OR cost_price >= 0);
ALTER TABLE product_variants ADD CONSTRAINT variants_on_hand_ck CHECK (on_hand >= 0);
ALTER TABLE product_variants ADD CONSTRAINT variants_reserved_ck CHECK (reserved >= 0);
-- NOTE: reserved may exceed on_hand only after a physical recount/write-off (oversold); checkout never allows it.
ALTER TABLE product_variants ADD CONSTRAINT variants_weight_ck  CHECK (weight_g IS NULL OR weight_g > 0);
-- All three dimensions absent, or all three present and positive. (The previous form
-- "(all NULL) OR (l>0 AND w>0 AND h>0)" evaluated to NULL, i.e. passed, when only some were set.)
ALTER TABLE product_variants ADD CONSTRAINT variants_dims_ck    CHECK (
  (length_cm IS NULL AND width_cm IS NULL AND height_cm IS NULL)
  OR (length_cm IS NOT NULL AND width_cm IS NOT NULL AND height_cm IS NOT NULL
      AND length_cm > 0 AND width_cm > 0 AND height_cm > 0));
ALTER TABLE product_variants ADD CONSTRAINT variants_low_stock_ck CHECK (low_stock_threshold >= 0);
ALTER TABLE product_variants ADD CONSTRAINT variants_hex_ck     CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9A-Fa-f]{6}$');
ALTER TABLE addresses        ADD CONSTRAINT addresses_pincode_ck CHECK (pincode ~ '^[1-9][0-9]{5}$');
ALTER TABLE testimonials     ADD CONSTRAINT testimonials_rating_ck CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE media            ADD CONSTRAINT media_size_ck CHECK (declared_size > 0 AND (size_bytes IS NULL OR size_bytes > 0));

-- ── Cart, coupons, shipping ─────────────────────────────────────────────
ALTER TABLE cart_items ADD CONSTRAINT cart_items_qty_ck CHECK (quantity BETWEEN 1 AND 50);
ALTER TABLE coupons ADD CONSTRAINT coupons_value_ck CHECK (
  (type = 'PERCENT' AND value BETWEEN 1 AND 100) OR (type = 'FLAT' AND value > 0) OR (type = 'FREE_SHIPPING' AND value = 0));
ALTER TABLE coupons ADD CONSTRAINT coupons_counts_ck CHECK (reserved_count >= 0 AND redeemed_count >= 0);
ALTER TABLE coupons ADD CONSTRAINT coupons_capacity_ck CHECK (usage_limit_total IS NULL OR reserved_count + redeemed_count <= usage_limit_total);
ALTER TABLE coupons ADD CONSTRAINT coupons_window_ck CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at);
ALTER TABLE coupon_redemptions ADD CONSTRAINT redemptions_discount_ck CHECK (discount >= 0);
ALTER TABLE shipping_rate_slabs ADD CONSTRAINT slabs_ck CHECK (max_weight_g > 0 AND rate >= 0);
ALTER TABLE shipping_zones ADD CONSTRAINT zones_extra_ck CHECK (extra_per_kg >= 0);

-- ── Orders ──────────────────────────────────────────────────────────────
ALTER TABLE orders ADD CONSTRAINT orders_money_ck CHECK (
  subtotal >= 0 AND mrp_total >= subtotal AND coupon_discount BETWEEN 0 AND subtotal
  AND shipping_fee >= 0 AND cod_fee >= 0 AND captured_amount >= 0 AND refunded_amount >= 0 AND tax_total >= 0);
ALTER TABLE orders ADD CONSTRAINT orders_total_ck CHECK (total = subtotal - coupon_discount + shipping_fee + cod_fee);
-- Refund capacity at order level (reserved = REQUESTED + PENDING + UNKNOWN + PROCESSED allocations of
-- order-funded refunds; excess/late-capture refunds are capped on their own payment row instead).
ALTER TABLE orders ADD CONSTRAINT orders_refund_cap_ck CHECK (
  refund_reserved_total <= CASE WHEN payment_method = 'COD' THEN total ELSE captured_amount END
  AND refund_reserved_shipping BETWEEN 0 AND shipping_fee
  AND refund_reserved_cod_fee  BETWEEN 0 AND cod_fee
  AND refunded_amount BETWEEN 0 AND refund_reserved_total);
ALTER TABLE orders ADD CONSTRAINT orders_cod_fee_ck CHECK (payment_method = 'COD' OR cod_fee = 0);
ALTER TABLE orders ADD CONSTRAINT orders_weights_ck CHECK (actual_weight_g > 0 AND chargeable_weight_g >= actual_weight_g);
ALTER TABLE order_items ADD CONSTRAINT order_items_ck CHECK (
  quantity > 0 AND unit_price > 0 AND line_total = unit_price * quantity
  AND discount BETWEEN 0 AND line_total AND net_amount = line_total - discount
  AND tax_amount BETWEEN 0 AND net_amount AND weight_g > 0
  AND return_requested_qty BETWEEN 0 AND quantity AND returned_qty BETWEEN 0 AND return_requested_qty
  AND refund_reserved_qty BETWEEN 0 AND quantity AND refund_reserved_amount BETWEEN 0 AND net_amount
  AND refunded_qty BETWEEN 0 AND refund_reserved_qty AND refunded_amount BETWEEN 0 AND refund_reserved_amount);

-- ── Inventory ───────────────────────────────────────────────────────────
ALTER TABLE inventory_reservations ADD CONSTRAINT reservations_ck CHECK (
  quantity > 0
  AND (status <> 'CONSUMED' OR consumed_at IS NOT NULL)
  AND (status <> 'RELEASED' OR released_at IS NOT NULL));
ALTER TABLE inventory_movements ADD CONSTRAINT movements_after_ck CHECK (on_hand_after >= 0 AND reserved_after >= 0);

-- ── Payments & refunds ──────────────────────────────────────────────────
ALTER TABLE payment_attempts ADD CONSTRAINT attempts_amount_ck CHECK (amount > 0);
ALTER TABLE payments ADD CONSTRAINT payments_amount_ck CHECK (
  amount > 0 AND refund_reserved BETWEEN 0 AND amount AND amount_refunded BETWEEN 0 AND refund_reserved
  AND provider_amount_refunded BETWEEN 0 AND amount);
ALTER TABLE payments ADD CONSTRAINT payments_allocation_ck CHECK (
  (allocation IS NULL) = (allocated_at IS NULL)
  AND (allocation IS NULL OR allocation = 'UNLINKED' OR status_rank >= 3));
ALTER TABLE refunds ADD CONSTRAINT refunds_amount_ck CHECK (
  amount > 0 AND items_amount >= 0 AND shipping_amount >= 0 AND cod_fee_amount >= 0 AND unallocated_amount >= 0
  AND amount = items_amount + shipping_amount + cod_fee_amount + unallocated_amount
  AND (unallocated_amount = 0 OR (kind IN ('EXCESS_CAPTURE','LATE_CAPTURE','PROVIDER_INITIATED')
                                  AND items_amount = 0 AND shipping_amount = 0 AND cod_fee_amount = 0)));
ALTER TABLE refunds ADD CONSTRAINT refunds_method_ck CHECK (
  (method = 'ORIGINAL_PAYMENT' AND payment_id IS NOT NULL) OR (method = 'MANUAL_BANK' AND payment_id IS NULL));
ALTER TABLE refund_attempts ADD CONSTRAINT refund_attempts_key_ck CHECK (
  provider_idempotency_key ~ '^[A-Za-z0-9_-]{10,64}$' AND attempt_no >= 1);
ALTER TABLE refund_items ADD CONSTRAINT refund_items_ck CHECK (quantity >= 0 AND amount >= 0 AND tax_amount BETWEEN 0 AND amount);
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_owner_ck CHECK (
  (status <> 'PROCESSING' OR owner_token IS NOT NULL) AND generation >= 0);
ALTER TABLE webhook_events ADD CONSTRAINT webhook_lease_ck CHECK (
  (status = 'PROCESSING') = (lease_token IS NOT NULL AND locked_until IS NOT NULL));
ALTER TABLE outbox_deliveries ADD CONSTRAINT outbox_lease_ck CHECK (
  (status = 'LEASED') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  AND (status <> 'COMPLETED' OR completed_at IS NOT NULL) AND generation >= 0);
ALTER TABLE cod_remittances ADD CONSTRAINT cod_remit_amount_ck CHECK (amount > 0);
ALTER TABLE cod_remittance_items ADD CONSTRAINT cod_remit_item_amount_ck CHECK (amount > 0);

-- ── Returns ─────────────────────────────────────────────────────────────
-- Each quantity individually bounded; sellable/damaged recorded together and only after receipt;
-- when recorded they must account for every received unit. (The previous form accepted e.g. -1 + 3 = 2.)
ALTER TABLE return_request_items ADD CONSTRAINT return_items_qty_ck CHECK (
  requested_qty > 0
  AND (approved_qty IS NULL OR approved_qty BETWEEN 0 AND requested_qty)
  AND (received_qty IS NULL OR (approved_qty IS NOT NULL AND received_qty BETWEEN 0 AND approved_qty))
  AND ((sellable_qty IS NULL AND damaged_qty IS NULL)
       OR (received_qty IS NOT NULL AND sellable_qty IS NOT NULL AND damaged_qty IS NOT NULL
           AND sellable_qty BETWEEN 0 AND received_qty AND damaged_qty BETWEEN 0 AND received_qty
           AND sellable_qty + damaged_qty = received_qty)));

-- A return can only become INSPECTED when every approved item has a complete inspection record.
CREATE OR REPLACE FUNCTION return_inspection_complete_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'INSPECTED' AND OLD.status IS DISTINCT FROM 'INSPECTED' AND EXISTS (
       SELECT 1 FROM return_request_items i
        WHERE i.return_request_id = NEW.id AND COALESCE(i.approved_qty, 0) > 0
          AND (i.received_qty IS NULL OR i.sellable_qty IS NULL OR i.damaged_qty IS NULL)) THEN
    RAISE EXCEPTION 'return % cannot be INSPECTED: incomplete item inspection', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER return_inspection_complete_trg BEFORE UPDATE OF status ON return_requests
  FOR EACH ROW EXECUTE FUNCTION return_inspection_complete_guard();

-- ── Sequences ───────────────────────────────────────────────────────────
CREATE SEQUENCE order_number_seq START 10001;   -- 'AQ' || nextval('order_number_seq')

-- ── Invoices are immutable once issued ─────────────────────────────────
CREATE OR REPLACE FUNCTION invoices_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoices are immutable (id=%)', OLD.id;
  END IF;
  -- only allowed change: attaching the rendered PDF once
  IF (to_jsonb(NEW) - 'pdf_media_id') <> (to_jsonb(OLD) - 'pdf_media_id')
     OR (OLD.pdf_media_id IS NOT NULL AND NEW.pdf_media_id IS DISTINCT FROM OLD.pdf_media_id) THEN
    RAISE EXCEPTION 'invoices are immutable (id=%); issue a credit note instead', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER invoices_immutable_trg BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_immutable();

-- Order items are snapshots: commercial columns never change after insert.
CREATE OR REPLACE FUNCTION order_items_snapshot_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.order_id, NEW.product_id, NEW.variant_id, NEW.product_name, NEW.variant_label, NEW.sku,
      NEW.unit_price, NEW.unit_mrp, NEW.quantity, NEW.line_total, NEW.discount, NEW.net_amount,
      NEW.tax_rate, NEW.tax_amount, NEW.hsn_code, NEW.weight_g)
     IS DISTINCT FROM
     (OLD.order_id, OLD.product_id, OLD.variant_id, OLD.product_name, OLD.variant_label, OLD.sku,
      OLD.unit_price, OLD.unit_mrp, OLD.quantity, OLD.line_total, OLD.discount, OLD.net_amount,
      OLD.tax_rate, OLD.tax_amount, OLD.hsn_code, OLD.weight_g) THEN
    RAISE EXCEPTION 'order_items snapshot columns are immutable (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER order_items_snapshot_trg BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_snapshot_guard();

-- ── Search document ─────────────────────────────────────────────────────
-- Lock strategy (database.md §4.1): triggers never lock rows of OTHER tables. The product's own
-- vector is computed in a BEFORE trigger on products (no extra row lock). Changes to variants,
-- categories or types only APPEND to search_reindex_queue (no unique key ⇒ inserts never wait on
-- each other); the search worker drains the queue in its own short transactions.
CREATE INDEX products_name_trgm   ON products USING GIN (name gin_trgm_ops);
CREATE INDEX products_tags_gin    ON products USING GIN (tags);
CREATE INDEX products_search_gin  ON products USING GIN (search_vector);
CREATE INDEX variants_filter_idx  ON product_variants (product_id, is_active, price) WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION product_search_vector(p products) RETURNS tsvector AS $$
  SELECT
      setweight(to_tsvector('simple', unaccent(coalesce(p.name,''))), 'A')
   || setweight(to_tsvector('simple', unaccent(coalesce((SELECT name FROM product_types WHERE id = p.type_id),'') || ' ' ||
                                               coalesce((SELECT name FROM categories WHERE id = p.category_id),''))), 'B')
   || setweight(to_tsvector('simple', unaccent(array_to_string(p.tags,' ') || ' ' || coalesce((
        SELECT string_agg(concat_ws(' ', sku, size, color, thickness), ' ' ORDER BY id)   -- deterministic order
          FROM product_variants WHERE product_id = p.id AND deleted_at IS NULL AND is_active), ''))), 'C')
   || setweight(to_tsvector('english', regexp_replace(coalesce(p.description,''), '<[^>]+>', ' ', 'g')), 'D')
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION products_search_trg_fn() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := product_search_vector(NEW);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER products_search_trg BEFORE INSERT OR UPDATE OF name, tags, description, type_id, category_id ON products
  FOR EACH ROW EXECUTE FUNCTION products_search_trg_fn();

CREATE OR REPLACE FUNCTION variants_search_enqueue_fn() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN INSERT INTO search_reindex_queue (product_id) VALUES (NEW.product_id); END IF;
  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.product_id <> NEW.product_id) THEN
    INSERT INTO search_reindex_queue (product_id) VALUES (OLD.product_id);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER variants_search_trg AFTER INSERT OR DELETE OR UPDATE OF sku, size, color, thickness, is_active, deleted_at, product_id
  ON product_variants FOR EACH ROW EXECUTE FUNCTION variants_search_enqueue_fn();

CREATE OR REPLACE FUNCTION taxonomy_search_enqueue_fn() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'categories' THEN
    INSERT INTO search_reindex_queue (product_id) SELECT id FROM products WHERE category_id = NEW.id;
  ELSE
    INSERT INTO search_reindex_queue (product_id) SELECT id FROM products WHERE type_id = NEW.id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER categories_search_trg AFTER UPDATE OF name ON categories
  FOR EACH ROW EXECUTE FUNCTION taxonomy_search_enqueue_fn();
CREATE TRIGGER types_search_trg AFTER UPDATE OF name ON product_types
  FOR EACH ROW EXECUTE FUNCTION taxonomy_search_enqueue_fn();

-- ── Publication gate: evaluated by the DB on every transition to ACTIVE ──────
-- The service evaluates the same function, stores the result in products.readiness and sets
-- is_publishable/published_at; this trigger is the backstop. It cannot re-run automatically when a
-- related row changes after publication; the service edit-guard blocks such changes and the
-- published_not_ready view (nightly check → PUBLISHED_NOT_READY exception) detects any that slip through.
CREATE OR REPLACE FUNCTION product_readiness_failures(p products) RETURNS text[] AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN p.type_id IS NULL OR p.category_id IS NULL THEN 'taxonomy' END,
    CASE WHEN p.description IS NULL OR btrim(p.description) = '' THEN 'no_description' END,
    CASE WHEN p.hsn_code IS NULL OR p.gst_rate IS NULL OR p.tax_approved_at IS NULL THEN 'no_tax' END,
    CASE WHEN cardinality(p.data_flags) > 0 THEN 'has_flags' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM product_images pi JOIN media m ON m.id = pi.media_id
                           WHERE pi.product_id = p.id AND pi.is_cover AND m.status = 'READY'
                             AND m.visibility = 'PUBLIC' AND m.deleted_at IS NULL) THEN 'no_image' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active AND v.deleted_at IS NULL)
         THEN 'no_active_variant' END,
    CASE WHEN EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active AND v.deleted_at IS NULL
                        AND (v.price IS NULL OR v.net_quantity IS NULL OR v.net_unit IS NULL)) THEN 'no_price_or_size' END,
    CASE WHEN EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active AND v.deleted_at IS NULL
                        AND v.inventory_counted_at IS NULL) THEN 'stock_uncounted' END,
    CASE WHEN EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active AND v.deleted_at IS NULL
                        AND (v.weight_g IS NULL OR v.weight_source IS DISTINCT FROM 'MEASURED'
                             OR (v.shipping_class = 'BULKY' AND v.length_cm IS NULL))) THEN 'shipping_data' END,
    CASE WHEN EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active AND v.deleted_at IS NULL
                        AND cardinality(v.data_flags) > 0) THEN 'variant_flags' END
  ]::text[], NULL)
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION products_publish_gate_fn() RETURNS trigger AS $$
DECLARE f text[];
BEGIN
  IF NEW.status = 'ACTIVE' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'ACTIVE') THEN
    f := product_readiness_failures(NEW);
    IF cardinality(f) > 0 THEN
      RAISE EXCEPTION 'NOT_PUBLISHABLE: %', array_to_string(f, ',') USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER products_publish_gate_trg BEFORE INSERT OR UPDATE OF status ON products
  FOR EACH ROW EXECUTE FUNCTION products_publish_gate_fn();

CREATE OR REPLACE VIEW published_not_ready AS
  SELECT p.id, f AS failures FROM products p CROSS JOIN LATERAL product_readiness_failures(p) f
  WHERE p.status = 'ACTIVE' AND cardinality(f) > 0;

-- ── Aggregate rebuild + drift detection ────────────────────────────────
-- The application updates aggregates in the same transaction as every variant change;
-- this function is the single definition, also used by the nightly drift check.
CREATE OR REPLACE FUNCTION product_aggregates(p_id INT)
RETURNS TABLE (min_price INT, max_price INT, max_mrp INT, available_qty INT, active_variant_count INT) AS $$
  SELECT MIN(price) FILTER (WHERE price IS NOT NULL),
         MAX(price) FILTER (WHERE price IS NOT NULL),
         MAX(mrp),
         COALESCE(SUM(GREATEST(on_hand - reserved, 0)), 0)::INT,
         COUNT(*)::INT
  FROM product_variants
  WHERE product_id = p_id AND is_active AND deleted_at IS NULL
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE VIEW product_aggregate_drift AS
  SELECT p.id, p.min_price, a.min_price AS exp_min_price, p.max_price, a.max_price AS exp_max_price,
         p.max_mrp, a.max_mrp AS exp_max_mrp, p.available_qty, a.available_qty AS exp_available_qty,
         p.active_variant_count, a.active_variant_count AS exp_active_variant_count
  FROM products p CROSS JOIN LATERAL product_aggregates(p.id) a
  WHERE (p.min_price, p.max_price, p.max_mrp, p.available_qty, p.active_variant_count)
        IS DISTINCT FROM (a.min_price, a.max_price, a.max_mrp, a.available_qty, a.active_variant_count);

CREATE OR REPLACE VIEW variant_reservation_drift AS
  SELECT v.id, v.reserved, COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'ACTIVE'), 0) AS expected_reserved
  FROM product_variants v LEFT JOIN inventory_reservations r ON r.variant_id = v.id
  GROUP BY v.id, v.reserved
  HAVING v.reserved <> COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'ACTIVE'), 0);
