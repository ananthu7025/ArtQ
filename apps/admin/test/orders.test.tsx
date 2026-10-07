// Task 5.1: Orders list and detail against a fake API: filters sent to the server, the next step as one button (with
// "email the customer"), a refused step explained and reloaded, address correction with the shared schema (empty →
// messages, server field errors on their fields), the staff note limit (2,000 / 2,001), resend, packing slip, 404.
import { permissionsFor, type AdminOrderDetail, type AdminOrderRow } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

const row: AdminOrderRow = {
  id: 7, orderNumber: 'AQ10234', createdAt: '2026-10-05T06:30:00Z', placedAt: '2026-10-05T06:31:00Z',
  customer: { name: 'Hema Rajan', email: 'hema@example.com', phone: '+919847012345', city: 'Kochi', pincode: '682011', isGuest: true },
  itemCount: 2, total: 111_000, paymentMethod: 'COD', status: 'PLACED', paymentStatus: 'COD_PENDING', fulfilmentStatus: 'UNFULFILLED', returnStatus: 'NONE', hasOpenException: false,
};
const detail = (o: Partial<AdminOrderDetail> = {}): AdminOrderDetail => ({
  ...row, version: 3, contactMasked: false, contactEmailVerified: false, userId: null,
  shippingAddress: { fullName: 'Hema Rajan', phone: '+919847012345', line1: '12 Rose Villa', line2: null, landmark: 'SBI', city: 'Kochi', state: 'Kerala', stateId: 32, pincode: '682011' },
  billing: { sameAsShipping: true, address: null, gstin: null, businessName: null },
  items: [{ id: 1, productId: 11, variantId: 101, name: 'Epoxy Resin', label: '500 ml', sku: 'RES-500', imageUrl: null, unitPrice: 50_000, quantity: 2, lineTotal: 100_000, discount: 0, netAmount: 100_000, taxRate: 18, taxAmount: 15_254, refundedQty: 0, returnedQty: 0 }],
  totals: { subtotal: 100_000, mrpTotal: 100_000, couponDiscount: 0, couponCode: null, shippingFee: 7000, codFee: 4000, total: 111_000, taxTotal: 15_254, capturedAmount: 0, refundedAmount: 0 },
  weights: { actualG: 1150, chargeableG: 1150 }, notes: { customer: 'Please call before delivery', admin: null },
  times: { expiresAt: null, confirmedAt: null, completedAt: null, cancelledAt: null, expiredAt: null, cancelReason: null },
  attempts: [], payments: [], refunds: [], exceptions: [], shipment: null, invoices: [],
  history: [{ dimension: 'ORDER', from: 'PENDING_PAYMENT', to: 'PLACED', note: null, actor: 'CUSTOMER', actorName: null, at: '2026-10-05T06:31:00Z' }],
  emails: [{ id: 1, template: 'order_placed', subject: 'Order AQ10234 placed', to: 'hema@example.com', status: 'SENT', at: '2026-10-05T06:32:00Z' }],
  actions: ['confirm', 'edit-address'], resendable: ['order_placed'], ...o,
});
const page = <T,>(rows: T[]) => [200, { data: rows, meta: { page: 1, limit: 25, total: rows.length, totalPages: 1 } }] as [number, unknown];

function setup(path: string, extra: Record<string, Handler> = {}, role: 'STAFF' | 'ADMIN' = 'ADMIN') {
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 1, name: 'Anu', email: 'anu@artq.in', role } }],
    'GET /admin/me': () => [200, { user: { id: 1, name: 'Anu', email: 'anu@artq.in', role }, permissions: permissionsFor(role) }],
    'GET /admin/orders': () => page([row]),
    'GET /admin/orders/7': () => [200, detail()],
    'GET /states': () => [200, { data: [{ id: 29, name: 'Karnataka' }, { id: 32, name: 'Kerala' }] }],
    ...extra,
  });
  window.history.replaceState({}, '', path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const sent = (s: ReturnType<typeof setup>['server'], method: string, path: string) => s.calls.filter((c) => c.method === method && c.path === path);
const noAxe = async (node: Element) => expect((await axe.run(node, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
afterEach(() => vi.restoreAllMocks());

describe('Orders list', () => {
  it('rows with the four statuses; filters go to the server; links to the order; passes axe', async () => {
    const u = userEvent.setup();
    const { container, server } = setup('/orders');
    const table = within(await screen.findByRole('table', { name: 'Orders' }));
    expect((await table.findByRole('link', { name: 'AQ10234' })).getAttribute('href')).toBe('/orders/7');
    expect(table.getByText('Placed')).toBeTruthy();
    expect(table.getByText('COD: to collect')).toBeTruthy();
    expect(table.getByText('Not packed')).toBeTruthy();
    expect(table.getByText('2 items · COD')).toBeTruthy();
    await noAxe(container);
    await u.selectOptions(screen.getByLabelText('Fulfilment'), 'PACKED');
    await u.selectOptions(screen.getByLabelText('Method'), 'COD');
    await u.click(screen.getByLabelText('Open exceptions only'));
    await u.type(screen.getByLabelText('Order, email, phone or name'), 'hema{Enter}');
    await waitFor(() => {
      const q = sent(server, 'GET', '/admin/orders').at(-1)!.query;
      expect([q.get('fulfilmentStatus'), q.get('method'), q.get('exception'), q.get('q'), q.get('limit')]).toEqual(['PACKED', 'COD', '1', 'hema', '25']);
    });
    await u.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect((screen.getByLabelText('Method') as HTMLSelectElement).value).toBe(''));   // the unfiltered list is already cached
    expect((screen.getByLabelText('Order, email, phone or name') as HTMLInputElement).value).toBe('');
    expect(window.location.search).toBe('');
  });
});

describe('Order detail', () => {
  it('shows the order and confirms it with "email the customer" (on by default, can be turned off); passes axe', async () => {
    const u = userEvent.setup();
    const { container, server } = setup('/orders/7', { 'POST /admin/orders/7/confirm': () => [200, detail({ status: 'CONFIRMED', version: 4, actions: ['pack', 'edit-address'] })] });
    expect(await screen.findByRole('heading', { name: 'Order AQ10234' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Items' })).getByText('500 ml')).toBeTruthy();
    expect(screen.getByText('Please call before delivery')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Timeline' })).getByText('Order: Placed')).toBeTruthy();
    await noAxe(container);
    await u.click(screen.getByRole('button', { name: 'Confirm order' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Confirm this order?' }));
    expect((dialog.getByLabelText('Email the customer') as HTMLInputElement).checked).toBe(true);
    await u.click(dialog.getByLabelText('Email the customer'));
    await u.click(dialog.getByRole('button', { name: 'Confirm order' }));
    await waitFor(() => expect(sent(server, 'POST', '/admin/orders/7/confirm')[0]?.body).toEqual({ notifyCustomer: false }));
    expect(await screen.findByRole('button', { name: 'Mark packed' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm order' })).toBeNull();
  });

  it('pack sends an empty body; a refused step says why and reloads the order', async () => {
    const u = userEvent.setup();
    let current = detail({ status: 'CONFIRMED', actions: ['pack', 'edit-address'] });
    const { server } = setup('/orders/7', {
      'GET /admin/orders/7': () => [200, current],
      'POST /admin/orders/7/pack': () => { current = detail({ status: 'CANCELLED', actions: [] }); return err(422, 'INVALID_TRANSITION', 'This order can’t be packed now: it is cancelled, not packed, cash on delivery. Reload to see its latest state.'); },
    });
    await u.click(await screen.findByRole('button', { name: 'Mark packed' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Mark as packed?' })).getByRole('button', { name: 'Mark packed' }));
    expect(await screen.findByText(/can’t be packed now: it is cancelled/)).toBeTruthy();
    expect(sent(server, 'POST', '/admin/orders/7/pack')[0]!.body).toEqual({});
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark packed' })).toBeNull());
    expect(screen.getByText('Cancelled')).toBeTruthy();
  });

  it('address correction: shared rules under each field, server field errors on their fields, saved with the version', async () => {
    const u = userEvent.setup();
    let reply: [number, unknown] = err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'shippingAddress.pincode', message: 'This pincode is in Kerala' }]);
    const { server } = setup('/orders/7', { 'PATCH /admin/orders/7': () => reply });
    await u.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Correct the delivery address' }));
    await u.clear(dialog.getByLabelText('Full name'));
    await u.clear(dialog.getByLabelText('Pincode'));
    await u.type(dialog.getByLabelText('Pincode'), '68201');
    await u.click(dialog.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expectFieldError('Full name', 'Enter the name for delivery', dialog));
    expectFieldError('Pincode', 'Enter a 6-digit pincode', dialog);
    expect(sent(server, 'PATCH', '/admin/orders/7')).toHaveLength(0);
    await u.type(dialog.getByLabelText('Full name'), 'Hema R');
    await u.clear(dialog.getByLabelText('Pincode'));
    await u.type(dialog.getByLabelText('Pincode'), '560001');
    await u.click(dialog.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expectFieldError('Pincode', 'This pincode is in Kerala', dialog));
    await u.selectOptions(dialog.getByLabelText('State'), '29');
    reply = [200, detail({ version: 4, shippingAddress: { ...detail().shippingAddress, fullName: 'Hema R', state: 'Karnataka', stateId: 29, pincode: '560001' } })];
    await u.click(dialog.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(sent(server, 'PATCH', '/admin/orders/7').at(-1)!.body).toEqual({ version: 3, shippingAddress: { fullName: 'Hema R', phone: '+919847012345', line1: '12 Rose Villa', line2: null, landmark: 'SBI', city: 'Kochi', stateId: 29, pincode: '560001' } }));
    expect(await screen.findByText('Kochi, Karnataka 560001')).toBeTruthy();
  });

  it('staff note: 2,000 characters save, 2,001 are refused under the field (shared rule); not after a version conflict', async () => {
    const u = userEvent.setup();
    const { server } = setup('/orders/7', { 'PATCH /admin/orders/7': (c) => [200, detail({ version: 4, notes: { customer: null, admin: (c.body as { adminNote: string }).adminNote } })] });
    const note = await screen.findByLabelText('Staff note (not shown to the customer)');
    await u.click(note);
    await u.paste('x'.repeat(2001));
    await u.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expectFieldError('Staff note (not shown to the customer)', 'Use at most 2,000 characters'));
    expect(sent(server, 'PATCH', '/admin/orders/7')).toHaveLength(0);
    await u.keyboard('{Backspace}');
    await u.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(sent(server, 'PATCH', '/admin/orders/7')[0]?.body).toEqual({ version: 3, adminNote: 'x'.repeat(2000) }));
    expect(await screen.findByText('Note saved')).toBeTruthy();
  });

  it('resend an email that fits the order; the packing slip opens as a PDF', async () => {
    const u = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:slip'), revokeObjectURL: vi.fn() }));
    const { server } = setup('/orders/7', {
      'GET /admin/orders/7': () => [200, detail({ status: 'CONFIRMED', resendable: ['order_placed', 'order_confirmed'] })],
      'POST /admin/orders/7/resend-email': () => [200, detail()],
      'GET /admin/orders/7/packing-slip': () => [200, '%PDF'],
    });
    await u.click(await screen.findByRole('button', { name: 'Resend email' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Resend an email' }));
    expect((dialog.getByLabelText('Order confirmed') as HTMLInputElement).checked).toBe(true);
    await u.click(dialog.getByLabelText('Order placed'));
    await u.click(dialog.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent(server, 'POST', '/admin/orders/7/resend-email')[0]?.body).toEqual({ template: 'order_placed' }));
    expect(await screen.findByText('“Order placed” email queued')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Packing slip' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:slip', '_blank', 'noopener'));
  });

  it('shipped order: out for delivery then delivered; STAFF sees the masked-contact note; an unknown order is not found', async () => {
    const u = userEvent.setup();
    const shipped = detail({ status: 'CONFIRMED', fulfilmentStatus: 'SHIPPED', contactMasked: true, customer: { ...row.customer, email: 'h***@example.com' }, actions: ['out-for-delivery', 'deliver'],
      shipment: { courierName: 'DTDC', awbNumber: 'D123', trackingUrl: 'https://track.test/D123', status: 'SHIPPED', weightG: 1200, shippedAt: '2026-10-06T06:00:00Z', deliveredAt: null } });
    const { server, unmount } = setup('/orders/7', { 'GET /admin/orders/7': () => [200, shipped], 'POST /admin/orders/7/deliver': () => [200, detail({ ...shipped, fulfilmentStatus: 'DELIVERED', paymentStatus: 'COD_COLLECTED', actions: [] })] }, 'STAFF');
    expect(await screen.findByText(/Contact details are partly hidden for your role/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'D123' }).getAttribute('href')).toBe('https://track.test/D123');
    await u.click(screen.getByRole('button', { name: 'Mark delivered' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Mark as delivered?' })).getByRole('button', { name: 'Mark delivered' }));
    await waitFor(() => expect(sent(server, 'POST', '/admin/orders/7/deliver')[0]?.body).toEqual({ notifyCustomer: true }));
    expect(await screen.findByText('COD: collected')).toBeTruthy();
    unmount();
    setup('/orders/9', { 'GET /admin/orders/9': () => err(404, 'NOT_FOUND', 'Order not found') });
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeTruthy();
  });

  it('ship: shared rules under each field (empty, AWB format, https link, whole grams), an AWB already used lands on its field, then ships', async () => {
    const u = userEvent.setup();
    const packed = detail({ status: 'CONFIRMED', fulfilmentStatus: 'PACKED', actions: ['ship'] });
    let reply: [number, unknown] = err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'awbNumber', message: 'This AWB number is already used for another DTDC shipment' }]);
    const { server } = setup('/orders/7', { 'GET /admin/orders/7': () => [200, packed], 'POST /admin/orders/7/ship': () => reply });
    await u.click(await screen.findByRole('button', { name: 'Ship' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Ship this order' }));
    expect((dialog.getByLabelText('Parcel weight (grams, optional)') as HTMLInputElement).value).toBe('1150');
    await u.click(dialog.getByRole('button', { name: 'Ship and issue invoice' }));
    await waitFor(() => expectFieldError('Courier', 'Enter the courier', dialog));
    expectFieldError('AWB / tracking number', 'Use 4 to 40 letters, digits or dashes', dialog);
    await u.type(dialog.getByLabelText('Courier'), 'DTDC');
    await u.type(dialog.getByLabelText('AWB / tracking number'), 'd12');
    await u.type(dialog.getByLabelText('Tracking link (optional)'), 'http://track.test/x');
    await u.clear(dialog.getByLabelText('Parcel weight (grams, optional)'));
    await u.type(dialog.getByLabelText('Parcel weight (grams, optional)'), '12.5');
    await u.click(dialog.getByRole('button', { name: 'Ship and issue invoice' }));
    await waitFor(() => expectFieldError('Parcel weight (grams, optional)', 'Use whole grams', dialog));
    await u.clear(dialog.getByLabelText('Parcel weight (grams, optional)'));
    await u.type(dialog.getByLabelText('Parcel weight (grams, optional)'), '1400');
    await u.click(dialog.getByRole('button', { name: 'Ship and issue invoice' }));
    await waitFor(() => expectFieldError('AWB / tracking number', 'Use 4 to 40 letters, digits or dashes', dialog));
    expectFieldError('Tracking link (optional)', 'Enter a full https:// link', dialog);
    expect(sent(server, 'POST', '/admin/orders/7/ship')).toHaveLength(0);
    await u.type(dialog.getByLabelText('AWB / tracking number'), '345');
    await u.clear(dialog.getByLabelText('Tracking link (optional)'));
    await u.click(dialog.getByRole('button', { name: 'Ship and issue invoice' }));
    await waitFor(() => expectFieldError('AWB / tracking number', 'This AWB number is already used for another DTDC shipment', dialog));
    expect(sent(server, 'POST', '/admin/orders/7/ship')[0]!.body).toEqual({ courierName: 'DTDC', awbNumber: 'D12345', trackingUrl: null, weightG: 1400, notifyCustomer: true });
    reply = [200, detail({ status: 'CONFIRMED', fulfilmentStatus: 'SHIPPED', actions: ['out-for-delivery', 'deliver'], invoices: [{ id: 3, kind: 'TAX_INVOICE', number: 'AQ/26-27/000003', issuedAt: '2026-10-07T06:00:00Z', grandTotal: 111_000 }],
      shipment: { courierName: 'DTDC', awbNumber: 'D12346', trackingUrl: null, status: 'SHIPPED', weightG: 1400, shippedAt: '2026-10-07T06:00:00Z', deliveredAt: null } })];
    await u.clear(dialog.getByLabelText('AWB / tracking number'));
    await u.type(dialog.getByLabelText('AWB / tracking number'), 'D12346');
    await u.click(dialog.getByRole('button', { name: 'Ship and issue invoice' }));
    expect(await screen.findByText('AQ10234 shipped; invoice issued')).toBeTruthy();
    expect(screen.getByText('AQ/26-27/000003')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Out for delivery' })).toBeTruthy();
  });

  it('invoice: opens the signed link in a new tab; an error closes the tab and says why', async () => {
    const u = userEvent.setup();
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    let reply: [number, unknown] = [200, { number: 'AQ/26-27/000003', url: 'https://storage.test/priv/inv.pdf?exp=300' }];
    setup('/orders/7', { 'GET /admin/orders/7': () => [200, detail({ status: 'CONFIRMED', fulfilmentStatus: 'SHIPPED', invoices: [{ id: 3, kind: 'TAX_INVOICE', number: 'AQ/26-27/000003', issuedAt: '2026-10-07T06:00:00Z', grandTotal: 111_000 }] })],
      'GET /admin/orders/7/invoice': () => reply });
    await u.click(await screen.findByRole('button', { name: 'Invoice' }));
    await waitFor(() => expect(tab.location.href).toBe('https://storage.test/priv/inv.pdf?exp=300'));
    reply = err(503, 'UNAVAILABLE', 'Storage is unavailable. Try again shortly.');
    await u.click(screen.getByRole('button', { name: 'Invoice' }));
    expect(await screen.findByText('Storage is unavailable. Try again shortly.', undefined, { timeout: 4000 })).toBeTruthy();
    expect(tab.close).toHaveBeenCalled();
  });

  it('cancel: reason required on its field (shared rule, 300 max), the refund is named, one Idempotency-Key per dialog (reused on retry), staff without orders:cancel see no button', async () => {
    const u = userEvent.setup();
    const paid = detail({ paymentMethod: 'RAZORPAY', paymentStatus: 'PAID', totals: { ...detail().totals, codFee: 0, total: 107_000, capturedAmount: 107_000 }, actions: ['confirm', 'edit-address', 'cancel'] });
    let reply: [number, unknown] = err(503, 'UNAVAILABLE', 'Try again shortly.');
    const { server, unmount } = setup('/orders/7', { 'GET /admin/orders/7': () => [200, paid], 'POST /admin/orders/7/cancel': () => reply });
    await u.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Cancel order AQ10234?' }));
    expect(dialog.getByText(/₹1,070 will be refunded automatically to the original payment method/)).toBeTruthy();
    await u.click(dialog.getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expectFieldError('Reason (kept on the order)', 'Say why the order is cancelled', dialog));
    await u.click(dialog.getByLabelText('Reason (kept on the order)'));
    await u.paste('x'.repeat(301));
    await u.click(dialog.getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expectFieldError('Reason (kept on the order)', 'Use at most 300 characters', dialog));
    expect(sent(server, 'POST', '/admin/orders/7/cancel')).toHaveLength(0);
    await u.clear(dialog.getByLabelText('Reason (kept on the order)'));
    await u.type(dialog.getByLabelText('Reason (kept on the order)'), 'Customer asked by phone');
    await u.click(dialog.getByLabelText('Email the customer'));
    await u.click(dialog.getByRole('button', { name: 'Cancel order' }));
    expect(await dialog.findByText('Try again shortly.', undefined, { timeout: 4000 })).toBeTruthy();
    reply = [200, detail({ ...paid, status: 'CANCELLED', actions: [], refunds: [{ id: 9, kind: 'CANCELLATION', method: 'ORIGINAL_PAYMENT', status: 'REQUESTED', amount: 107_000, reason: 'Customer asked by phone', createdAt: '2026-10-07T06:00:00Z', processedAt: null }] })];
    await u.click(dialog.getByRole('button', { name: 'Cancel order' }));
    expect(await screen.findByText('AQ10234 cancelled')).toBeTruthy();
    const calls = sent(server, 'POST', '/admin/orders/7/cancel');
    expect(calls.at(-1)!.body).toEqual({ reason: 'Customer asked by phone', notifyCustomer: false });
    expect(calls.at(-1)!.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(calls.map((c) => c.headers['Idempotency-Key'])).size).toBe(1);
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
    unmount();
    setup('/orders/7', { 'GET /admin/orders/7': () => [200, paid] }, 'STAFF');
    expect(await screen.findByRole('button', { name: 'Confirm order' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
  });

  it('cancel: COD says nothing is collected; a refusal (already shipped) is explained and the order reloaded', async () => {
    const u = userEvent.setup();
    let current = detail({ actions: ['confirm', 'edit-address', 'cancel'] });
    const { server } = setup('/orders/7', {
      'GET /admin/orders/7': () => [200, current],
      'POST /admin/orders/7/cancel': () => { current = detail({ status: 'CONFIRMED', fulfilmentStatus: 'SHIPPED', actions: ['out-for-delivery', 'deliver'] }); return err(422, 'INVALID_TRANSITION', 'This order can’t be cancelled now: it is confirmed, shipped, cash on delivery.'); },
    });
    await u.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Cancel order AQ10234?' }));
    expect(dialog.getByText(/Nothing was paid; the courier won’t collect anything/)).toBeTruthy();
    await u.type(dialog.getByLabelText('Reason (kept on the order)'), 'Duplicate order');
    await u.click(dialog.getByRole('button', { name: 'Cancel order' }));
    expect(await screen.findByText('This order can’t be cancelled now: it is confirmed, shipped, cash on delivery.')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark delivered' })).toBeTruthy());
    expect(sent(server, 'GET', '/admin/orders/7').length).toBeGreaterThan(1);
  });
});
