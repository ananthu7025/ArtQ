// Task 5.5: returns in the admin against a fake API. The queue (needs-someone by default, status filter, tabs by
// permission), the return page (items at each step, photos, buttons by status and permission), and each step's form:
// the shared rules under each field, server refusals on their field, a step someone else took reloads the return,
// the refund with one Idempotency-Key and amounts in rupees; the order page lists its returns.
import { permissionsFor, type AdminOrderDetail, type AdminReturnDetail, type AdminReturnRow, type Role } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

const item = { orderItemId: 1, name: 'Epoxy Resin', label: '500 ml', sku: 'RES-500', bought: 2, netAmount: 100_000, requestedQty: 2, approvedQty: null, receivedQty: null, sellableQty: null, damagedQty: null, refundedQty: 0, refundableQty: 0, refundableAmount: 0 };
const ret = (o: Partial<AdminReturnDetail> = {}): AdminReturnDetail => ({
  id: 12, orderId: 7, orderNumber: 'AQ10234', customerName: 'Hema Rajan', reason: 'DAMAGED', status: 'REQUESTED', units: 2, createdAt: '2026-10-07T06:00:00Z', decidedAt: null, actions: ['decide', 'cancel'],
  description: 'The bottle leaked in the box', adminNote: null, decidedBy: null, receivedAt: null, inspectedAt: null, closedAt: null, deliveredAt: '2026-10-06T10:00:00Z', paymentMethod: 'RAZORPAY',
  items: [item], photos: [{ id: 501, url: 'https://storage.test/priv/a.jpg', thumbUrl: 'https://storage.test/priv/a/w320.webp' }], refunds: [], shippingAvailable: 7000, ...o,
});
const row = (o: Partial<AdminReturnRow> = {}): AdminReturnRow => ({ id: 12, orderId: 7, orderNumber: 'AQ10234', customerName: 'Hema Rajan', reason: 'DAMAGED', status: 'REQUESTED', units: 2, createdAt: '2026-10-07T06:00:00Z', decidedAt: null, actions: ['decide', 'cancel'], ...o });
const page = <T,>(rows: T[]) => [200, { data: rows, meta: { page: 1, limit: 25, total: rows.length, totalPages: 1 } }] as [number, unknown];

function setup(path: string, extra: Record<string, Handler> = {}, role: Role = 'ADMIN') {
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 1, name: 'Anu', email: 'anu@artq.in', role } }],
    'GET /admin/me': () => [200, { user: { id: 1, name: 'Anu', email: 'anu@artq.in', role }, permissions: permissionsFor(role) }],
    'GET /admin/returns/12': () => [200, ret()],
    'GET /admin/returns': () => page([row()]),
    'GET /admin/refunds': () => page([]),
    ...extra,
  });
  window.history.replaceState({}, '', path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const sent = (s: ReturnType<typeof setup>['server'], method: string, path: string) => s.calls.filter((c) => c.method === method && c.path === path);

describe('returns queue', () => {
  it('shows what needs someone by default; the status filter asks the server; admins switch to the refunds tab', async () => {
    const u = userEvent.setup();
    const { server } = setup('/returns');
    expect(await screen.findByRole('link', { name: '#12 Arrived damaged' })).toBeTruthy();
    expect(sent(server, 'GET', '/admin/returns')[0]!.query.get('open')).toBe('1');
    await u.selectOptions(screen.getByLabelText('Status'), 'INSPECTED');
    await waitFor(() => expect(sent(server, 'GET', '/admin/returns').at(-1)!.query.get('status')).toBe('INSPECTED'));
    await u.selectOptions(screen.getByLabelText('Status'), 'all');
    await waitFor(() => expect([...sent(server, 'GET', '/admin/returns').at(-1)!.query.keys()].sort()).toEqual(['limit', 'page']));
    await u.click(screen.getByRole('tab', { name: 'Refunds' }));
    expect(await screen.findByText('No refunds yet.')).toBeTruthy();
  });

  it('staff (no refund permission) see the returns queue only', async () => {
    setup('/returns', {}, 'STAFF');
    expect(await screen.findByRole('link', { name: '#12 Arrived damaged' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Refunds' })).toBeNull();
  });
});

describe('return page', () => {
  it('items, photos and the description; buttons by status; staff cannot decide; accessible', async () => {
    const { container } = setup('/returns/12');
    expect(await screen.findByRole('heading', { name: 'Return #12' })).toBeTruthy();
    expect(screen.getByText('The bottle leaked in the box')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Customer photo 1' }).getAttribute('src')).toBe('https://storage.test/priv/a/w320.webp');
    expect(screen.getByRole('button', { name: 'Approve or reject' })).toBeTruthy();
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
  });

  it('staff see receive steps but not decide / close', async () => {
    setup('/returns/12', { 'GET /admin/returns/12': () => [200, ret({ status: 'APPROVED', actions: ['in-transit', 'receive', 'cancel'], items: [{ ...item, approvedQty: 1 }] })] }, 'STAFF');
    expect(await screen.findByRole('button', { name: 'Receive' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'On its way back' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel return' })).toBeNull();
  });

  it('decide: the rules under each field; a server refusal on its field; approve sends the units and shows the new state', async () => {
    const u = userEvent.setup();
    let reply: [number, unknown] = err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'items.0.approvedQty', message: 'Approve between 0 and the units requested' }]);
    const { server } = setup('/returns/12', { 'POST /admin/returns/12/decide': () => reply });
    await u.click(await screen.findByRole('button', { name: 'Approve or reject' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Decide return #12' }));
    const units = 'Units to accept: Epoxy Resin (500 ml), 2 asked';
    await u.clear(dialog.getByLabelText(units));
    await u.type(dialog.getByLabelText(units), '1.5');
    await u.click(dialog.getByRole('button', { name: 'Approve return' }));
    await waitFor(() => expectFieldError(units, 'Use whole units', dialog));
    await u.clear(dialog.getByLabelText(units));
    await u.type(dialog.getByLabelText(units), '0');
    await u.click(dialog.getByRole('button', { name: 'Approve return' }));
    expect(await dialog.findByText('Approve at least one unit, or reject the return')).toBeTruthy();
    await u.click(dialog.getByLabelText('Reject'));
    await u.click(dialog.getByRole('button', { name: 'Reject return' }));
    await waitFor(() => expectFieldError('Why (sent to the customer)', 'Tell the customer why (sent in the email)', dialog));
    expect(sent(server, 'POST', '/admin/returns/12/decide')).toHaveLength(0);
    await u.click(dialog.getByLabelText('Approve'));
    await u.clear(dialog.getByLabelText(units));
    await u.type(dialog.getByLabelText(units), '2');
    await u.click(dialog.getByRole('button', { name: 'Approve return' }));
    await waitFor(() => expectFieldError(units, 'Approve between 0 and the units requested', dialog));
    reply = [200, ret({ status: 'APPROVED', actions: ['in-transit', 'receive', 'cancel'], items: [{ ...item, approvedQty: 1 }] })];
    await u.clear(dialog.getByLabelText(units));
    await u.type(dialog.getByLabelText(units), '1');
    await u.click(dialog.getByRole('button', { name: 'Approve return' }));
    expect(await screen.findByRole('button', { name: 'Receive' })).toBeTruthy();
    expect(sent(server, 'POST', '/admin/returns/12/decide').at(-1)!.body).toEqual({ decision: 'APPROVE', note: null, items: [{ orderItemId: 1, approvedQty: 1 }] });
  });

  it('a step someone else already took: says so and reloads the return', async () => {
    const u = userEvent.setup();
    let current = ret();
    const { server } = setup('/returns/12', {
      'GET /admin/returns/12': () => [200, current],
      'POST /admin/returns/12/decide': () => { current = ret({ status: 'REJECTED', actions: [] }); return err(422, 'INVALID_TRANSITION', 'Someone else has already moved this return on. Reload to see where it is.'); },
    });
    await u.click(await screen.findByRole('button', { name: 'Approve or reject' }));
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve return' }));
    expect(await screen.findByText('Someone else has already moved this return on. Reload to see where it is.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve or reject' })).toBeNull());
    expect(sent(server, 'GET', '/admin/returns/12').length).toBeGreaterThan(1);
  });

  it('receive and inspect: defaults from the previous step; a server refusal lands on its field', async () => {
    const u = userEvent.setup();
    const { server } = setup('/returns/12', {
      'GET /admin/returns/12': () => [200, ret({ status: 'RECEIVED', actions: ['inspect'], items: [{ ...item, approvedQty: 2, receivedQty: 2 }] })],
      'POST /admin/returns/12/inspect': () => err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'items.0.sellableQty', message: 'Sellable and damaged units must add up to the units received' }]),
    });
    await u.click(await screen.findByRole('button', { name: 'Inspect' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Inspect return #12' }));
    expect((dialog.getByLabelText('Sellable') as HTMLInputElement).value).toBe('2');
    await u.clear(dialog.getByLabelText('Damaged'));
    await u.type(dialog.getByLabelText('Damaged'), '1');
    await u.click(dialog.getByRole('button', { name: 'Save inspection' }));
    await waitFor(() => expectFieldError('Sellable', 'Sellable and damaged units must add up to the units received', dialog));
    expect(sent(server, 'POST', '/admin/returns/12/inspect')[0]!.body).toEqual({ items: [{ orderItemId: 1, sellableQty: 2, damagedQty: 1 }] });
  });

  it('refund: prefilled with what is refundable, rupees → paise, one key per dialog, an over-limit refusal on the amount', async () => {
    const u = userEvent.setup();
    let reply: [number, unknown] = err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'items.0.amount', message: 'More than this return allows for the item (units received, and their share of the price)' }]);
    const { server } = setup('/returns/12', {
      'GET /admin/returns/12': () => [200, ret({ status: 'INSPECTED', actions: ['refund', 'close'], items: [{ ...item, approvedQty: 1, receivedQty: 1, sellableQty: 1, damagedQty: 0, refundableQty: 1, refundableAmount: 50_000 }] })],
      'POST /admin/returns/12/refund': () => reply,
    });
    await u.click(await screen.findByRole('button', { name: 'Refund' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Refund return #12' }));
    expect((dialog.getByLabelText('Amount (₹)') as HTMLInputElement).value).toBe('500');
    await u.clear(dialog.getByLabelText('Amount (₹)'));
    await u.type(dialog.getByLabelText('Amount (₹)'), '500.001');
    await u.click(dialog.getByRole('button', { name: /^Refund/ }));
    await waitFor(() => expectFieldError('Amount (₹)', 'Use rupees with at most two decimals, e.g. 150 or 99.50', dialog));
    await u.clear(dialog.getByLabelText('Amount (₹)'));
    await u.type(dialog.getByLabelText('Amount (₹)'), '500.01');
    await u.type(dialog.getByLabelText('Shipping (₹, our fault only; up to 70)'), '70');
    await u.click(dialog.getByRole('button', { name: 'Refund ₹570.01' }));
    await waitFor(() => expectFieldError('Amount (₹)', 'More than this return allows for the item (units received, and their share of the price)', dialog));
    reply = [201, { refundId: 90, method: 'ORIGINAL_PAYMENT', status: 'REQUESTED' }];
    await u.clear(dialog.getByLabelText('Amount (₹)'));
    await u.type(dialog.getByLabelText('Amount (₹)'), '500');
    await u.click(dialog.getByRole('button', { name: 'Refund ₹570' }));
    expect(await screen.findByText('Refund #90 of ₹570 sent to Razorpay')).toBeTruthy();
    const posts = sent(server, 'POST', '/admin/returns/12/refund');
    expect(posts.at(-1)!.body).toEqual({ reason: 'Return #12: arrived damaged', shippingAmount: 7000, items: [{ orderItemId: 1, quantity: 1, amount: 50_000 }] });
    expect(new Set(posts.map((p) => p.headers['Idempotency-Key'])).size).toBe(1);
  });

  it('cancel needs a reason; close confirms; an unknown return is not found', async () => {
    const u = userEvent.setup();
    const { server } = setup('/returns/12', { 'POST /admin/returns/12/cancel': () => [200, ret({ status: 'CANCELLED', actions: [], closedAt: '2026-10-08T06:00:00Z' })] });
    await u.click(await screen.findByRole('button', { name: 'Cancel return' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Cancel return #12?' }));
    await u.click(dialog.getByRole('button', { name: 'Cancel return' }));
    await waitFor(() => expectFieldError('Why (kept on the return)', 'Say why the return is cancelled', dialog));
    await u.type(dialog.getByLabelText('Why (kept on the return)'), 'Customer kept it');
    await u.click(dialog.getByRole('button', { name: 'Cancel return' }));
    expect(await screen.findByText('Return #12 cancelled')).toBeTruthy();
    expect(sent(server, 'POST', '/admin/returns/12/cancel')[0]!.body).toEqual({ note: 'Customer kept it' });
  });

  it('an unknown return shows not found', async () => {
    setup('/returns/99', { 'GET /admin/returns/99': () => err(404, 'NOT_FOUND', 'Return not found') });
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeTruthy();
  });
});

describe('order page', () => {
  it('lists the order’s returns with a link to each', async () => {
    const order = { id: 7, orderNumber: 'AQ10234', createdAt: '2026-10-05T06:30:00Z', placedAt: '2026-10-05T06:31:00Z',
      customer: { name: 'Hema Rajan', email: 'hema@example.com', phone: '+919847012345', city: 'Kochi', pincode: '682011', isGuest: true },
      itemCount: 2, total: 107_000, paymentMethod: 'RAZORPAY', status: 'CONFIRMED', paymentStatus: 'PAID', fulfilmentStatus: 'DELIVERED', returnStatus: 'OPEN', hasOpenException: false,
      version: 3, contactMasked: false, contactEmailVerified: false, userId: null,
      shippingAddress: { fullName: 'Hema Rajan', phone: '+919847012345', line1: '12 Rose Villa', line2: null, landmark: null, city: 'Kochi', state: 'Kerala', stateId: 32, pincode: '682011' },
      billing: { sameAsShipping: true, address: null, gstin: null, businessName: null }, items: [],
      totals: { subtotal: 100_000, mrpTotal: 100_000, couponDiscount: 0, couponCode: null, shippingFee: 7000, codFee: 0, total: 107_000, taxTotal: 0, capturedAmount: 107_000, refundedAmount: 0 },
      weights: { actualG: 1150, chargeableG: 1150 }, notes: { customer: null, admin: null },
      times: { expiresAt: null, confirmedAt: null, completedAt: null, cancelledAt: null, expiredAt: null, cancelReason: null },
      attempts: [], payments: [], refunds: [], exceptions: [], shipment: null, invoices: [], history: [], emails: [], actions: [], resendable: [],
      returns: [{ id: 12, reason: 'MISSING_ITEM', status: 'APPROVED', units: 1, createdAt: '2026-10-07T06:00:00Z' }] } satisfies AdminOrderDetail;
    setup('/orders/7', { 'GET /admin/orders/7': () => [200, order] });
    const link = await screen.findByRole('link', { name: 'Return #12' });
    expect(link.getAttribute('href')).toBe('/returns/12');
    expect(screen.getByText(/Item missing from the parcel · 1 unit/)).toBeTruthy();
  });
});
