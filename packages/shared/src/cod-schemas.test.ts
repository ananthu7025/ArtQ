// COD remittance and RTO / lost bodies (task 5.6): what the API and the forms both enforce, at each boundary.
import { describe, expect, it } from 'vitest';
import { codOutstandingQuery, codRemittanceBody } from './cod-schemas.js';
import { adminOrderListQuery, lostOrderBody, rtoReceivedBody } from './order-admin-schemas.js';

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));
const ok = { courierName: 'DTDC', reference: 'UTR123', remittedAt: '2026-10-05', amount: 150_000, orders: [{ orderNumber: 'aq10001', amount: 100_000 }, { orderNumber: 'AQ10002', amount: 50_000 }] };

describe('codRemittanceBody', () => {
  it('valid: order numbers upper-cased, note defaults to null', () => {
    expect(codRemittanceBody.parse(ok)).toEqual({ ...ok, note: null, orders: [{ orderNumber: 'AQ10001', amount: 100_000 }, { orderNumber: 'AQ10002', amount: 50_000 }] });
  });
  it('empty → every field; lines must add up (message names the sum); each order once; at least one order', () => {
    expect(Object.keys(issues(codRemittanceBody.safeParse({})))).toEqual(['courierName', 'reference', 'remittedAt', 'amount', 'orders']);
    expect(issues(codRemittanceBody.safeParse({ ...ok, amount: 150_001 }))).toEqual({ amount: 'The orders add up to ₹1,500' });
    expect(issues(codRemittanceBody.safeParse({ ...ok, amount: 200_000, orders: [ok.orders[0], ok.orders[0]] }))).toEqual({ 'orders.1.orderNumber': 'Each order only once' });
    expect(issues(codRemittanceBody.safeParse({ ...ok, orders: [] }))).toEqual({ orders: 'Add at least one order' });
  });
  it('boundaries: ₹0.01 ok, ₹0 not; reference 3 ok, 2 not; 80 ok, 81 not; dates must be real', () => {
    expect(codRemittanceBody.safeParse({ ...ok, amount: 1, orders: [{ orderNumber: 'AQ1', amount: 1 }] }).success).toBe(true);
    expect(issues(codRemittanceBody.safeParse({ ...ok, amount: 0, orders: [{ orderNumber: 'AQ1', amount: 0 }] }))).toMatchObject({ amount: 'Enter more than ₹0', 'orders.0.amount': 'Enter more than ₹0' });
    expect(codRemittanceBody.safeParse({ ...ok, reference: 'abc' }).success).toBe(true);
    expect(issues(codRemittanceBody.safeParse({ ...ok, reference: 'ab' }))).toEqual({ reference: 'Enter the payout reference' });
    expect(codRemittanceBody.safeParse({ ...ok, reference: 'x'.repeat(80) }).success).toBe(true);
    expect(issues(codRemittanceBody.safeParse({ ...ok, reference: 'x'.repeat(81) }))).toEqual({ reference: 'Use at most 80 characters' });
    expect(issues(codRemittanceBody.safeParse({ ...ok, remittedAt: '2026-02-30' }))).toEqual({ remittedAt: 'Use a real date' });
    expect(codRemittanceBody.safeParse({ ...ok, remittedAt: '2028-02-29' }).success).toBe(true);           // leap day
    expect(issues(adminOrderListQuery.safeParse({ from: '2026-02-29' }))).toEqual({ from: 'Use a real date' });   // the orders filter shares the rule
    expect(issues(codRemittanceBody.safeParse({ ...ok, orders: [{ orderNumber: 'AQ 1', amount: 150_000 }] }))).toEqual({ 'orders.0.orderNumber': 'Enter an order number like AQ10234' });
  });
  it('outstanding query: overdue flag and limit up to 500', () => {
    expect(codOutstandingQuery.parse({ overdue: '1', limit: '500' })).toEqual({ overdue: '1', page: 1, limit: 500 });
    expect(codOutstandingQuery.safeParse({ limit: '501' }).success).toBe(false);
  });
});

describe('RTO and lost', () => {
  it('rto-received: whole units ≥ 0, every item once, at least one', () => {
    expect(rtoReceivedBody.parse({ items: [{ orderItemId: 1, sellableQty: 1, damagedQty: 0 }] })).toEqual({ items: [{ orderItemId: 1, sellableQty: 1, damagedQty: 0 }], notifyCustomer: true });
    expect(issues(rtoReceivedBody.safeParse({ items: [] }))).toEqual({ items: 'Inspect every item' });
    expect(issues(rtoReceivedBody.safeParse({ items: [{ orderItemId: 1, sellableQty: -1, damagedQty: 0.5 }] }))).toEqual({ 'items.0.sellableQty': 'Use 0 or more', 'items.0.damagedQty': 'Use whole units' });
    expect(issues(rtoReceivedBody.safeParse({ items: [{ orderItemId: 1, sellableQty: 1, damagedQty: 0 }, { orderItemId: 1, sellableQty: 1, damagedQty: 0 }] }))).toEqual({ 'items.1.orderItemId': 'Each item only once' });
  });
  it('lost: resolution and a note (3 ok, 2 not; 300 ok, 301 not)', () => {
    expect(Object.keys(issues(lostOrderBody.safeParse({})))).toEqual(['resolution', 'note']);
    expect(lostOrderBody.safeParse({ resolution: 'RESHIP', note: 'abc' }).success).toBe(true);
    expect(issues(lostOrderBody.safeParse({ resolution: 'REFUND', note: 'ab' }))).toEqual({ note: 'Note the courier’s claim or reference' });
    expect(lostOrderBody.safeParse({ resolution: 'REFUND', note: 'x'.repeat(300) }).success).toBe(true);
    expect(issues(lostOrderBody.safeParse({ resolution: 'REFUND', note: 'x'.repeat(301) }))).toEqual({ note: 'Use at most 300 characters' });
  });
});
