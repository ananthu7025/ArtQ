// Return request and staff step bodies (task 5.5): what the API and the forms both enforce, at each boundary.
import { describe, expect, it } from 'vitest';
import { customerReturnBody, returnCancelBody, returnDecideBody, returnInspectBody, returnListQuery, returnReceiveBody, returnRefundBody } from './return-schemas.js';

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));
const item = { orderItemId: 1, quantity: 1 };

describe('customerReturnBody', () => {
  it('a damaged item with a photo; defaults; an empty description becomes null', () => {
    expect(customerReturnBody.parse({ reason: 'DAMAGED', description: '  ', items: [item], mediaIds: [5] })).toEqual({ reason: 'DAMAGED', description: null, items: [item], mediaIds: [5] });
    expect(customerReturnBody.parse({ reason: 'MISSING_ITEM', items: [item] })).toMatchObject({ mediaIds: [], description: null });
  });
  it('empty body → reason and items; OTHER is not a customer reason; unknown keys refused', () => {
    expect(Object.keys(issues(customerReturnBody.safeParse({})))).toEqual(['reason', 'items']);
    expect(issues(customerReturnBody.safeParse({ reason: 'OTHER', items: [item] }))).toHaveProperty('reason', 'Choose what went wrong');
    expect(customerReturnBody.safeParse({ reason: 'MISSING_ITEM', items: [item], extra: 1 }).success).toBe(false);
  });
  it('photos: required unless missing; at most 6 (6 ok, 7 not); each once', () => {
    expect(issues(customerReturnBody.safeParse({ reason: 'DEFECTIVE', items: [item] }))).toEqual({ mediaIds: 'Add at least one photo of the problem' });
    expect(customerReturnBody.safeParse({ reason: 'DEFECTIVE', items: [item], mediaIds: [1, 2, 3, 4, 5, 6] }).success).toBe(true);
    expect(issues(customerReturnBody.safeParse({ reason: 'DEFECTIVE', items: [item], mediaIds: [1, 2, 3, 4, 5, 6, 7] }))).toEqual({ mediaIds: 'At most 6 photos' });
    expect(issues(customerReturnBody.safeParse({ reason: 'DEFECTIVE', items: [item], mediaIds: [1, 1] }))).toEqual({ mediaIds: 'Each photo only once' });
  });
  it('quantities: at least 1, whole; items once; at least one item; description 1,000 ok, 1,001 not', () => {
    expect(issues(customerReturnBody.safeParse({ reason: 'MISSING_ITEM', items: [{ orderItemId: 1, quantity: 0 }] }))).toEqual({ 'items.0.quantity': 'Return at least 1' });
    expect(issues(customerReturnBody.safeParse({ reason: 'MISSING_ITEM', items: [{ orderItemId: 1, quantity: 1.5 }] }))).toEqual({ 'items.0.quantity': 'Use whole units' });
    expect(issues(customerReturnBody.safeParse({ reason: 'MISSING_ITEM', items: [item, item] }))).toEqual({ 'items.1.orderItemId': 'Each item only once' });
    expect(issues(customerReturnBody.safeParse({ reason: 'MISSING_ITEM', items: [] }))).toEqual({ items: 'Choose at least one item' });
    expect(customerReturnBody.safeParse({ reason: 'MISSING_ITEM', items: [item], description: 'x'.repeat(1000) }).success).toBe(true);
    expect(issues(customerReturnBody.safeParse({ reason: 'MISSING_ITEM', items: [item], description: 'x'.repeat(1001) }))).toEqual({ description: 'Use at most 1,000 characters' });
  });
});

describe('staff steps', () => {
  it('decide: approve needs a unit; reject needs a reason (3 chars ok, 2 not); note limit 500', () => {
    expect(returnDecideBody.parse({ decision: 'APPROVE', items: [{ orderItemId: 1, approvedQty: 1 }] })).toEqual({ decision: 'APPROVE', items: [{ orderItemId: 1, approvedQty: 1 }], note: null });
    expect(issues(returnDecideBody.safeParse({ decision: 'APPROVE', items: [{ orderItemId: 1, approvedQty: 0 }] }))).toEqual({ items: 'Approve at least one unit, or reject the return' });
    expect(issues(returnDecideBody.safeParse({ decision: 'REJECT', note: 'no' }))).toEqual({ note: 'Tell the customer why (sent in the email)' });
    expect(returnDecideBody.safeParse({ decision: 'REJECT', note: 'Old' }).success).toBe(true);
    expect(returnDecideBody.safeParse({ decision: 'REJECT', note: 'x'.repeat(500) }).success).toBe(true);
    expect(issues(returnDecideBody.safeParse({ decision: 'REJECT', note: 'x'.repeat(501) }))).toEqual({ note: 'Use at most 500 characters' });
    expect(issues(returnDecideBody.safeParse({ decision: 'APPROVE', items: [{ orderItemId: 1, approvedQty: -1 }] }))).toHaveProperty(['items.0.approvedQty'], 'Use 0 or more');
  });
  it('receive / inspect: whole units ≥ 0; each item once; receive needs an item', () => {
    expect(returnReceiveBody.safeParse({ items: [{ orderItemId: 1, receivedQty: 0 }] }).success).toBe(true);
    expect(issues(returnReceiveBody.safeParse({ items: [] }))).toHaveProperty('items');
    expect(issues(returnInspectBody.safeParse({ items: [{ orderItemId: 1, sellableQty: 1, damagedQty: 0.5 }] }))).toEqual({ 'items.0.damagedQty': 'Use whole units' });
    expect(issues(returnInspectBody.safeParse({ items: [{ orderItemId: 1, sellableQty: 1, damagedQty: 0 }, { orderItemId: 1, sellableQty: 0, damagedQty: 1 }] }))).toEqual({ 'items.1.orderItemId': 'Each item only once' });
  });
  it('cancel needs a reason; refund: units and amount together, something to refund, shipping ≥ 0', () => {
    expect(issues(returnCancelBody.safeParse({}))).toEqual({ note: 'Say why the return is cancelled' });
    const ok = { reason: 'Damaged', items: [{ orderItemId: 1, quantity: 1, amount: 50_000 }] };
    expect(returnRefundBody.parse(ok)).toEqual({ ...ok, shippingAmount: 0 });
    expect(issues(returnRefundBody.safeParse({ ...ok, items: [{ orderItemId: 1, quantity: 0, amount: 100 }] }))).toEqual({ 'items.0.quantity': 'Enter the units refunded' });
    expect(issues(returnRefundBody.safeParse({ ...ok, items: [{ orderItemId: 1, quantity: 1, amount: 0 }] }))).toEqual({ 'items.0.amount': 'Enter the amount for these units', '': 'Refund at least one returned item' });
    expect(issues(returnRefundBody.safeParse({ ...ok, shippingAmount: -1 }))).toEqual({ shippingAmount: 'Use 0 or more' });
    expect(returnRefundBody.safeParse({ ...ok, items: [{ orderItemId: 1, quantity: 1, amount: 100_000_000 }] }).success).toBe(true);
    expect(issues(returnRefundBody.safeParse({ ...ok, items: [{ orderItemId: 1, quantity: 1, amount: 100_000_001 }] }))).toEqual({ 'items.0.amount': 'At most ₹10,00,000' });
  });
  it('list query: status or open; page bounds', () => {
    expect(returnListQuery.parse({ open: '1', page: '2' })).toEqual({ open: '1', page: 2, limit: 25 });
    expect(returnListQuery.safeParse({ status: 'LOST' }).success).toBe(false);
    expect(returnListQuery.safeParse({ limit: '101' }).success).toBe(false);
  });
});
