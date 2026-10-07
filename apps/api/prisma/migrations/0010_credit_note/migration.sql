-- GENERATED from docs/database.md §8.5a by scripts/db-from-docs.mjs. Do not edit.
-- 0010 (task 5.4): aq_issue_credit_note, the credit note for a processed refund of an invoiced order (architecture.md
-- §10.4, database.md §8.5a). Called by the invoice.credit_note consumer on refund.processed with the content computed
-- by the API from the original invoice (same parties, place of supply, rates and HSN; the refunded item, shipping and
-- COD-fee amounts with their tax split). One credit note per refund (unique index below); numbered CN/<fy>/<6 digits>
-- from invoice_counters inside this transaction, so numbers are gap-free. A refund with nothing allocated to the
-- order (excess / late captures, unallocated provider refunds) or an order never invoiced gets none ('SKIPPED').
-- Lock order (§4.1): order → refund and invoices (order-owned) → invoice counter. Additive (index + function).
CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_credit_note_per_refund_uq ON invoices (refund_id) WHERE kind = 'CREDIT_NOTE';

CREATE OR REPLACE FUNCTION aq_issue_credit_note(p_refund INT, p_content JSONB, p_actor INT) RETURNS JSONB AS $$
DECLARE rf RECORD; orig RECORD; cn RECORD; v_part INT; v_fy TEXT; seq INT; v_no TEXT; v_id INT; lines_total BIGINT;
BEGIN
  SELECT order_id INTO rf FROM refunds WHERE id = p_refund;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND:refund %', p_refund USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM orders WHERE id = rf.order_id FOR NO KEY UPDATE;
  SELECT id, order_id, status, items_amount, shipping_amount, cod_fee_amount INTO rf FROM refunds WHERE id = p_refund FOR NO KEY UPDATE;
  IF rf.status <> 'PROCESSED' THEN RAISE EXCEPTION 'INVALID_TRANSITION:refund % is %', p_refund, rf.status USING ERRCODE = 'P0001'; END IF;
  SELECT id, number INTO cn FROM invoices WHERE refund_id = p_refund AND kind = 'CREDIT_NOTE';
  IF FOUND THEN RETURN jsonb_build_object('status', 'DUPLICATE', 'invoice_id', cn.id, 'number', cn.number); END IF;
  v_part := rf.items_amount + rf.shipping_amount + rf.cod_fee_amount;
  SELECT id, place_of_supply INTO orig FROM invoices WHERE order_id = rf.order_id AND kind = 'TAX_INVOICE';
  IF v_part = 0 OR NOT FOUND THEN RETURN jsonb_build_object('status', 'SKIPPED'); END IF;

  v_fy := p_content->>'fy';
  IF v_fy IS NULL OR v_fy !~ '^\d{2}-\d{2}$' THEN RAISE EXCEPTION 'INVOICE_INVALID:fy %', v_fy USING ERRCODE = 'P0001'; END IF;
  IF (p_content->>'place_of_supply') IS DISTINCT FROM orig.place_of_supply THEN
    RAISE EXCEPTION 'INVOICE_INVALID:place of supply differs from invoice %', orig.id USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(sum((l->>'taxable')::BIGINT + (l->>'cgst')::BIGINT + (l->>'sgst')::BIGINT + (l->>'igst')::BIGINT), 0) INTO lines_total
    FROM jsonb_array_elements(p_content->'lines') l;
  IF (p_content->>'grand_total')::BIGINT <> v_part OR lines_total + (p_content->>'rounding_adjustment')::BIGINT <> v_part
     OR (p_content->>'taxable_total')::BIGINT + (p_content->>'cgst_total')::BIGINT + (p_content->>'sgst_total')::BIGINT
        + (p_content->>'igst_total')::BIGINT + (p_content->>'rounding_adjustment')::BIGINT <> v_part THEN
    RAISE EXCEPTION 'INVOICE_INVALID:credit note does not add up to the refunded % for the order', v_part USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO invoice_counters (kind, fy, last_no) VALUES ('CREDIT_NOTE', v_fy, 1)
  ON CONFLICT (kind, fy) DO UPDATE SET last_no = invoice_counters.last_no + 1
  RETURNING last_no INTO seq;
  v_no := 'CN/' || v_fy || '/' || lpad(seq::TEXT, 6, '0');
  INSERT INTO invoices (order_id, kind, number, fy, seq, issued_at, original_invoice_id, refund_id, seller_snapshot, buyer_snapshot, place_of_supply,
                        lines, taxable_total, cgst_total, sgst_total, igst_total, rounding_adjustment, grand_total, created_by)
  VALUES (rf.order_id, 'CREDIT_NOTE', v_no, v_fy, seq, now(), orig.id, p_refund, p_content->'seller', p_content->'buyer', orig.place_of_supply,
          p_content->'lines', (p_content->>'taxable_total')::INT, (p_content->>'cgst_total')::INT, (p_content->>'sgst_total')::INT,
          (p_content->>'igst_total')::INT, (p_content->>'rounding_adjustment')::INT, v_part, p_actor)
  RETURNING id INTO v_id;
  PERFORM aq_emit('invoice', v_id::TEXT, 'invoice.render', jsonb_build_object('invoice_id', v_id, 'order_id', rf.order_id), ARRAY['invoice.render']);
  RETURN jsonb_build_object('status', 'ISSUED', 'invoice_id', v_id, 'number', v_no);
END $$ LANGUAGE plpgsql;
