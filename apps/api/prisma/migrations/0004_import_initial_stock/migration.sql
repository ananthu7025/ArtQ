-- 0004 (task 2.7): initial stock for a variant the catalogue import has just created (database.md §2 "Catalogue
-- import: new variant only → IMPORT_INITIAL", §6b, §9). Additive only.
--
-- Sets on_hand once, records the IMPORT_INITIAL movement and leaves inventory_counted_at NULL (imported stock is never
-- "counted"; a recount or inventory import confirms it). Refuses any variant that already has stock history or stock,
-- so a retried import batch can never add stock twice and an existing variant's stock is never changed by a catalogue
-- import. The caller refreshes product aggregates (aq_refresh_products) in the same transaction, after locking every
-- variant of the batch first (global lock order: variants ascending, then products).
CREATE OR REPLACE FUNCTION aq_import_initial_stock(p_variant INT, p_quantity INT, p_import INT, p_actor INT) RETURNS void AS $$
DECLARE v RECORD;
BEGIN
  IF p_quantity IS NULL OR p_quantity < 0 THEN RAISE EXCEPTION 'INVALID_ADJUSTMENT:%', p_variant; END IF;
  SELECT id, on_hand, reserved INTO v FROM product_variants WHERE id = p_variant AND deleted_at IS NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND:variant:%', p_variant; END IF;
  IF v.on_hand <> 0 OR v.reserved <> 0 OR EXISTS (SELECT 1 FROM inventory_movements WHERE variant_id = p_variant) THEN
    RAISE EXCEPTION 'STOCK_ALREADY_SET:%', p_variant;
  END IF;
  IF p_quantity > 0 THEN
    UPDATE product_variants SET on_hand = p_quantity, version = version + 1 WHERE id = p_variant;
  END IF;
  INSERT INTO inventory_movements (variant_id, reason, on_hand_delta, reserved_delta, on_hand_after, reserved_after, import_id, actor_id)
  VALUES (p_variant, 'IMPORT_INITIAL', p_quantity, 0, p_quantity, 0, p_import, p_actor);
END $$ LANGUAGE plpgsql;
