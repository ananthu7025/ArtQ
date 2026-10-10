// Task 5.6 in the admin against a fake API. Order page: Returning to us (a confirm step), Received back (every unit
// inspected; the shared rules and server refusals on their fields; the money explained), Lost in transit (refund or
// reship, a note required). COD Remittances: the waiting list with its summary and overdue flags, the payouts tab, and
// recording a payout (ticked orders only, amounts in rupees, the sum checked like the server, a server refusal on the
// ticked order's line, mismatches reported).
import { permissionsFor, type AdminOrderDetail, type CodOutstandingRow, type CodRemittanceRow, type Role } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

const order = (o: Partial<AdminOrderDetail> = {}): AdminOrderDetail => ({
  id: 7, orderNumber: 'AQ10234', createdAt: '2026-10-05T06:30:00Z', placedAt: '2026-10-05T06:31:00Z',
  customer: { name: 'Hema Rajan', email: 'hema@example.com', phone: '+919847012345', city: 'Kochi', pincode: '682011', isGuest: true },
  itemCount: 2, total: 107_000, paymentMethod: 'RAZORPAY', status: 'CONFIRMED', paymentStatus: 'PAID', fulfilmentStatus: 'SHIPPED', returnStatus: 'NONE', hasOpenException: false,
  version: 3, contactMasked: false, contactEmailVerified: false, userId: null,
  shippingAddress: { fullName: 'Hema Rajan', phone: '+919847012345', line1: '12 Rose Villa', line2: null, landmark: null, city: 'Kochi', state: 'Kerala', stateId: 32, pincode: '682011' },
  billing: { sameAsShipping: true, address: null, gstin: null, businessName: null },
  items: [{ id: 1, productId: 11, variantId: 101, name: 'Epoxy Resin', label: '500 ml', sku: 'RES-500', imageUrl: null, unitPrice: 50_000, quantity: 2, lineTotal: 100_000, discount: 0, netAmount: 100_000, taxRate: 18, taxAmount: 15_254, refundedQty: 0, returnedQty: 0 }],
  totals: { subtotal: 100_000, mrpTotal: 100_000, couponDiscount: 0, couponCode: null, shippingFee: 7000, codFee: 0, total: 107_000, taxTotal: 15_254, capturedAmount: 107_000, refundedAmount: 0 },
  weights: { actualG: 1150, chargeableG: 1150 }, notes: { customer: null, admin: null },
  times: { expiresAt: null, confirmedAt: null, completedAt: null, cancelledAt: null, expiredAt: null, cancelReason: null },
  attempts: [], payments: [], refunds: [], exceptions: [], shipment: null, invoices: [], returns: [], history: [], emails: [], actions: ['out-for-delivery', 'deliver', 'rto', 'lost'], resendable: [], ...o,
});
const waitingRow = (o: Partial<CodOutstandingRow> = {}): CodOutstandingRow => ({ orderId: 21, orderNumber: 'AQ10301', customerName: 'Anu', courierName: 'DTDC', awbNumber: 'D1', total: 110_800, deliveredAt: '2026-09-20T06:00:00Z', days: 19, overdue: true, ...o });
const payout = (o: Partial<CodRemittanceRow> = {}): CodRemittanceRow => ({ id: 3, courierName: 'DTDC', reference: 'UTR998', amount: 106_800, remittedAt: '2026-10-04T18:30:00Z', note: null, recordedBy: 'Anu', createdAt: '2026-10-05T06:00:00Z',
  orders: [{ orderId: 21, orderNumber: 'AQ10301', amount: 106_800, expected: 110_800 }], ...o });
const page = <T,>(rows: T[], extra: object = {}) => [200, { data: rows, meta: { page: 1, limit: 50, total: rows.length, totalPages: 1 }, ...extra }] as [number, unknown];
const summary = { count: 2, total: 160_800, overdueCount: 1, overdueTotal: 110_800 };

function setup(path: string, extra: Record<string, Handler> = {}, role: Role = 'ADMIN') {
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 1, name: 'Anu', email: 'anu@artq.in', role } }],
    'GET /admin/me': () => [200, { user: { id: 1, name: 'Anu', email: 'anu@artq.in', role }, permissions: permissionsFor(role) }],
    'GET /admin/orders/7': () => [200, order()],
    'GET /admin/refunds': () => page([]),
    'GET /admin/cod/outstanding': () => page([waitingRow(), waitingRow({ orderId: 22, orderNumber: 'AQ10302', total: 50_000, days: 3, overdue: false })], { summary }),
    'GET /admin/cod-remittances': () => page([payout()]),
    ...extra,
  });
  window.history.replaceState({}, '', path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const sent = (s: ReturnType<typeof setup>['server'], method: string, path: string) => s.calls.filter((c) => c.method === method && c.path === path);

describe('order page: RTO and lost', () => {
  it('returning to us is a confirmed step', async () => {
    const u = userEvent.setup();
    const { server } = setup('/orders/7', { 'POST /admin/orders/7/rto': () => [200, order({ fulfilmentStatus: 'RTO_IN_TRANSIT', actions: ['rto-received', 'lost'] })] });
    await u.click(await screen.findByRole('button', { name: 'Returning to us' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Is the parcel coming back to us?' })).getByRole('button', { name: 'Returning to us' }));
    expect(await screen.findByRole('button', { name: 'Received back' })).toBeTruthy();
    expect(sent(server, 'POST', '/admin/orders/7/rto')[0]!.body).toEqual({});
  });

  it('received back: defaults to all sellable; the rules under each field; a server refusal on its field; sends every line', async () => {
    const u = userEvent.setup();
    let reply: [number, unknown] = err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'items.0.sellableQty', message: 'Sellable and damaged units must add up to the units in the order' }]);
    const { server, container } = setup('/orders/7', {
      'GET /admin/orders/7': () => [200, order({ fulfilmentStatus: 'RTO_IN_TRANSIT', actions: ['rto-received', 'lost'] })],
      'POST /admin/orders/7/rto-received': () => reply,
    });
    await u.click(await screen.findByRole('button', { name: 'Received back' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'The parcel is back' }));
    expect(dialog.getByText(/The items \(up to ₹1,000\) are refunded automatically; the shipping charge isn’t\./)).toBeTruthy();
    expect((dialog.getByLabelText('Sellable: Epoxy Resin') as HTMLInputElement).value).toBe('2');
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
    await u.clear(dialog.getByLabelText('Damaged: Epoxy Resin'));
    await u.type(dialog.getByLabelText('Damaged: Epoxy Resin'), '0.5');
    await u.click(dialog.getByRole('button', { name: 'Restock and cancel order' }));
    await waitFor(() => expectFieldError('Damaged: Epoxy Resin', 'Use whole units', dialog));
    await u.clear(dialog.getByLabelText('Damaged: Epoxy Resin'));
    await u.type(dialog.getByLabelText('Damaged: Epoxy Resin'), '1');
    await u.click(dialog.getByRole('button', { name: 'Restock and cancel order' }));
    await waitFor(() => expectFieldError('Sellable: Epoxy Resin', 'Sellable and damaged units must add up to the units in the order', dialog));
    reply = [200, order({ status: 'CANCELLED', fulfilmentStatus: 'RTO_RECEIVED', actions: [] })];
    await u.clear(dialog.getByLabelText('Sellable: Epoxy Resin'));
    await u.type(dialog.getByLabelText('Sellable: Epoxy Resin'), '1');
    await u.click(dialog.getByRole('button', { name: 'Restock and cancel order' }));
    expect(await screen.findByText('AQ10234 received back and cancelled')).toBeTruthy();
    expect(sent(server, 'POST', '/admin/orders/7/rto-received').at(-1)!.body).toEqual({ notifyCustomer: true, items: [{ orderItemId: 1, sellableQty: 1, damagedQty: 1 }] });
  });

  it('lost: a note is required; refund is the default; reship can be chosen', async () => {
    const u = userEvent.setup();
    const { server } = setup('/orders/7', { 'POST /admin/orders/7/lost': () => [200, order({ fulfilmentStatus: 'LOST', actions: [] })] });
    await u.click(await screen.findByRole('button', { name: 'Lost in transit' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Parcel for AQ10234 lost?' }));
    expect(dialog.getByText(/cancel the order and refund everything paid, shipping included/)).toBeTruthy();
    await u.click(dialog.getByRole('button', { name: 'Mark lost' }));
    await waitFor(() => expectFieldError('Courier claim or reference', 'Note the courier’s claim or reference', dialog));
    await u.click(dialog.getByLabelText(/Reship/));
    await u.type(dialog.getByLabelText('Courier claim or reference'), 'DTDC claim 4471');
    await u.click(dialog.getByRole('button', { name: 'Mark lost' }));
    expect(await screen.findByText('AQ10234 marked lost')).toBeTruthy();
    expect(sent(server, 'POST', '/admin/orders/7/lost')[0]!.body).toEqual({ resolution: 'RESHIP', note: 'DTDC claim 4471', notifyCustomer: true });
  });
});

describe('COD Remittances', () => {
  it('waiting list: summary, overdue flag, filters asked of the server; the payouts tab shows short-paid orders', async () => {
    const u = userEvent.setup();
    const { server, container } = setup('/cod-remittances');
    expect(await screen.findByText(/from 2 orders not paid out yet/)).toBeTruthy();
    expect(screen.getByText('1 overdue (₹1,108)')).toBeTruthy();
    expect(screen.getByText('19 days ago · overdue')).toBeTruthy();
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
    await u.click(screen.getByLabelText('Overdue only'));
    await waitFor(() => expect(sent(server, 'GET', '/admin/cod/outstanding').at(-1)!.query.get('overdue')).toBe('1'));
    await u.type(screen.getByLabelText('Courier'), 'Delhivery{Enter}');
    await waitFor(() => expect(sent(server, 'GET', '/admin/cod/outstanding').at(-1)!.query.get('courier')).toBe('Delhivery'));
    await u.click(screen.getByRole('tab', { name: 'Payouts' }));
    expect(await screen.findByText('(order total ₹1,108)')).toBeTruthy();
  });

  it('staff without the permission do not see the page', async () => {
    setup('/cod-remittances', {}, 'STAFF');
    expect(await screen.findByRole('heading', { name: /not allowed|no access|permission/i })).toBeTruthy();
  });

  it('record a payout: rules on the fields, the sum must match, a refusal lands on the ticked order, mismatches reported', async () => {
    const u = userEvent.setup();
    let reply: [number, unknown] = err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'orders.0.orderNumber', message: 'Not a delivered cash-on-delivery order waiting for its cash (already remitted, not delivered, or paid online)' }]);
    const { server } = setup('/cod-remittances', { 'POST /admin/cod-remittances': () => reply });
    await u.click(await screen.findByRole('button', { name: 'Record payout' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Record a courier payout' }));
    await u.click(await dialog.findByRole('button', { name: 'Record payout' }));
    await waitFor(() => expectFieldError('Payout reference (UTR)', 'Enter the payout reference', dialog));
    expectFieldError('Amount paid (₹)', 'Enter the amount paid', dialog);
    expect(dialog.getByText('Add at least one order')).toBeTruthy();
    await u.type(dialog.getByLabelText('Payout reference (UTR)'), 'UTR998');
    await u.click(dialog.getByRole('checkbox', { name: /AQ10302/ }));
    await u.type(dialog.getByLabelText('Amount paid (₹)'), '400');
    await u.click(dialog.getByRole('button', { name: 'Record payout' }));
    await waitFor(() => expectFieldError('Amount paid (₹)', 'The orders add up to ₹500', dialog));
    expect(sent(server, 'POST', '/admin/cod-remittances')).toHaveLength(0);
    await u.clear(dialog.getByLabelText('Amount paid (₹)'));
    await u.type(dialog.getByLabelText('Amount paid (₹)'), '460');
    await u.clear(dialog.getByLabelText('Paid for AQ10302'));
    await u.type(dialog.getByLabelText('Paid for AQ10302'), '460');
    await u.click(dialog.getByRole('button', { name: 'Record payout' }));
    expect(await dialog.findByText('Not a delivered cash-on-delivery order waiting for its cash (already remitted, not delivered, or paid online)')).toBeTruthy();
    reply = [201, { remittance: payout({ reference: 'UTR998', orders: [{ orderId: 22, orderNumber: 'AQ10302', amount: 46_000, expected: 50_000 }] }), mismatches: [{ orderNumber: 'AQ10302', expected: 50_000, remitted: 46_000 }] }];
    await u.click(dialog.getByRole('button', { name: 'Record payout' }));
    expect(await screen.findByText('Payout recorded. 1 order was paid a different amount and flagged: AQ10302')).toBeTruthy();
    expect(sent(server, 'POST', '/admin/cod-remittances').at(-1)!.body).toEqual({ courierName: 'DTDC', reference: 'UTR998', remittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), note: null, amount: 46_000, orders: [{ orderNumber: 'AQ10302', amount: 46_000 }] });
  });
});
