-- 0006 (task 4.3): aq_reverse_coupon, the "reverse" step of the coupon lifecycle (database.md §3.7, decision D-14).
--
-- When a REDEEMED order (paid, or COD placed) is cancelled before dispatch, the customer gets the coupon use back:
-- the redemption goes REDEEMED → REVERSED and redeemed_count − 1, unless the use was honoured over the limit (an
-- over-limit use never counted). Gated by the row transition (UPDATE … WHERE status = 'REDEEMED'), so a repeated call
-- changes nothing and returns FALSE. Called inside the cancellation transaction after the order is CANCELLED; lock
-- order §4.1: order → coupon. Additive (a new function).
CREATE OR REPLACE FUNCTION aq_reverse_coupon(p_order INT) RETURNS BOOLEAN AS $$
DECLARE o RECORD; red RECORD;
BEGIN
  SELECT id, status INTO o FROM orders WHERE id = p_order FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND:order %', p_order USING ERRCODE = 'P0001'; END IF;
  IF o.status <> 'CANCELLED' THEN RAISE EXCEPTION 'INVARIANT: coupon reversal for order % in status %', p_order, o.status; END IF;
  UPDATE coupon_redemptions SET status = 'REVERSED', reversed_at = now()
   WHERE order_id = p_order AND status = 'REDEEMED' RETURNING coupon_id, over_limit INTO red;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  IF NOT red.over_limit THEN
    PERFORM 1 FROM coupons WHERE id = red.coupon_id FOR NO KEY UPDATE;
    UPDATE coupons SET redeemed_count = redeemed_count - 1 WHERE id = red.coupon_id;
  END IF;
  RETURN TRUE;
END $$ LANGUAGE plpgsql;
