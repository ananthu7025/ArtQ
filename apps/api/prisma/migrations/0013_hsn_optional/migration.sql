-- 0013: the HSN code is optional; tax approval needs a GST rate (0 % allowed) and its approval, not an HSN.
--
-- A seller that is not registered for GST charges no tax and has no use for HSN codes. "No GST" is stored as an approved
-- rate of 0 % (products_gst_rate_ck already allows 0–40), so the cart, pricing and checkout need no null-rate special case.
-- The gate previously also demanded `hsn_code IS NOT NULL`, in two places that must stay identical:
--   1. product_readiness_failures() → the 'no_tax' check (the single definition used by publish, edit-guard, trigger);
--   2. products_active_gate_ck      → the CHECK that an ACTIVE product satisfies the gate.
-- Both only RELAX the rule, so every row that satisfied the old rule still satisfies the new one (no data migration).
-- A product that has an HSN keeps it and it is still printed on tax invoices when GST is charged.
--
-- contract-phase: relaxes a CHECK (drop + re-add without the hsn_code term); no data is changed or removed.

CREATE OR REPLACE FUNCTION product_readiness_failures(p products) RETURNS text[] AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN p.type_id IS NULL OR p.category_id IS NULL THEN 'taxonomy' END,
    CASE WHEN p.description IS NULL OR btrim(p.description) = '' THEN 'no_description' END,
    CASE WHEN p.gst_rate IS NULL OR p.tax_approved_at IS NULL THEN 'no_tax' END,
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

ALTER TABLE products DROP CONSTRAINT products_active_gate_ck;
ALTER TABLE products ADD CONSTRAINT products_active_gate_ck CHECK (
  status <> 'ACTIVE' OR (is_publishable AND type_id IS NOT NULL AND category_id IS NOT NULL
                         AND gst_rate IS NOT NULL AND tax_approved_at IS NOT NULL
                         AND published_at IS NOT NULL));
