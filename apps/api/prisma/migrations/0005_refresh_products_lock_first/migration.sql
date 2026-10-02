-- 0005 (task 2.8): aq_refresh_products locks each product BEFORE computing its aggregates (database.md §6c).
--
-- The 0003 version computed the aggregates inside the UPDATE that waits for the product's row lock. Under READ COMMITTED
-- a statement keeps the snapshot it started with, so when two transactions changed DIFFERENT variants of the same
-- product at once (e.g. an inventory count and a checkout reservation, which lock only their own variants), the one that
-- waited wrote aggregates computed without the other's committed change → product_aggregate_drift.
-- Same rule as aq_process_search_queue: lock first, compute in a later statement (which sees every change committed
-- before the lock was granted). Behaviour is otherwise identical; additive (CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION aq_refresh_products(p_ids INT[]) RETURNS void AS $$
DECLARE pid INT;
BEGIN
  FOR pid IN SELECT DISTINCT x FROM unnest(p_ids) AS x WHERE x IS NOT NULL ORDER BY 1 LOOP
    PERFORM 1 FROM products WHERE id = pid FOR NO KEY UPDATE;
    UPDATE products p SET min_price = a.min_price, max_price = a.max_price, max_mrp = a.max_mrp,
                          available_qty = a.available_qty, active_variant_count = a.active_variant_count
      FROM product_aggregates(pid) a WHERE p.id = pid;
  END LOOP;
END $$ LANGUAGE plpgsql;
