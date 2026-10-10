// Task 5.9 in the admin against a fake API. Dashboard: the period switch asks the server; the figures, chart (values as
// text), waiting-for-you links by permission, low stock and top products. Customers: search and status filter, the
// detail, the staff note limit on its field, Block needs a reason, Unblock; STAFF sees no edit controls. Restock
// Requests: the groups, Notify now (only when available), already-sent-today, the waiting list and Remove.
import { permissionsFor, type AdminCustomerDetail, type AdminCustomerRow, type Dashboard, type RestockGroup, type Role } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

const dash = (o: Partial<Dashboard> = {}): Dashboard => ({
  range: '7d', revenue: 1_250_000, orders: 14, aov: 89_286, newCustomers: 5,
  salesSeries: Array.from({ length: 7 }, (_, i) => ({ label: `2026-10-0${i + 3}`, revenue: i === 6 ? 300_000 : 150_000, orders: 2 })),
  ordersByStatus: { PLACED: 3, CONFIRMED: 10, CANCELLED: 1 },
  pendingActions: { toConfirm: 3, toPack: 4, toShip: 2, returnsToDecide: 1, openExceptions: 2, restockRequests: 6, codOverdue: 0, messages: null },
  lowStock: [{ variantId: 101, productId: 11, productName: 'Epoxy Resin', label: '500 ml', sku: 'RES-500', available: 0, threshold: 5 }],
  topProducts: [{ productId: 11, name: 'Epoxy Resin', units: 9, revenue: 449_100 }], ...o,
});
const row = (o: Partial<AdminCustomerRow> = {}): AdminCustomerRow => ({ id: 3, name: 'Hema Rajan', email: 'hema@example.com', phone: '+919847012345', status: 'ACTIVE', emailVerified: true, orders: 2, spent: 214_000, createdAt: '2026-09-01T06:00:00Z', lastLoginAt: '2026-10-08T06:00:00Z', ...o });
const detail = (o: Partial<AdminCustomerDetail> = {}): AdminCustomerDetail => ({ ...row(), contactMasked: false, marketingOptIn: true, adminNotes: null, wishlistCount: 4,
  addresses: [{ id: 1, label: 'HOME', fullName: 'Hema Rajan', lines: ['12 Rose Villa', 'Kochi, Kerala 682011'], phone: '+919847012345', isDefault: true }],
  recentOrders: [{ id: 7, orderNumber: 'AQ10234', createdAt: '2026-10-05T06:00:00Z', total: 107_000, status: 'CONFIRMED', paymentStatus: 'PAID', fulfilmentStatus: 'DELIVERED' }], ...o });
const group = (o: Partial<RestockGroup> = {}): RestockGroup => ({ variantId: 101, sku: 'RES-500', label: '500 ml', product: { id: 11, name: 'Epoxy Resin', status: 'ACTIVE' }, pending: 3, oldestAt: '2026-09-20T06:00:00Z', available: 4, notifiedToday: false, ...o });
const page = <T,>(rows: T[]) => [200, { data: rows, meta: { page: 1, limit: 25, total: rows.length, totalPages: 1 } }] as [number, unknown];

function setup(path: string, extra: Record<string, Handler> = {}, role: Role = 'ADMIN') {
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 1, name: 'Anu', email: 'anu@artq.in', role } }],
    'GET /admin/me': () => [200, { user: { id: 1, name: 'Anu', email: 'anu@artq.in', role }, permissions: permissionsFor(role) }],
    'GET /admin/dashboard': () => [200, dash()],
    'GET /admin/customers': () => page([row()]),
    'GET /admin/customers/3': () => [200, detail()],
    'GET /admin/restock-requests': () => page([group(), group({ variantId: 102, label: '1 L', sku: 'RES-1L', available: 0, pending: 1 })]),
    ...extra,
  });
  window.history.replaceState({}, '', path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const sent = (s: ReturnType<typeof setup>['server'], method: string, path: string) => s.calls.filter((c) => c.method === method && c.path === path);

describe('dashboard', () => {
  it('figures, chart values as text, waiting-for-you links, low stock and top products; the period switch asks the server', async () => {
    const u = userEvent.setup();
    const { server, container } = setup('/dashboard');
    expect(await screen.findByText('₹12,500')).toBeTruthy();
    expect(screen.getByText('2026-10-09: ₹3,000, 2 order(s)')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Orders to pack\s*4/ }).getAttribute('href')).toBe('/orders?status=CONFIRMED&fulfilmentStatus=UNFULFILLED');
    expect(screen.getByRole('link', { name: /Customers waiting for stock\s*6/ }).getAttribute('href')).toBe('/restock-requests');
    expect(within(screen.getByRole('region', { name: 'Low stock' })).getByText('Sold out')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Top products' })).getByText('9 · ₹4,491')).toBeTruthy();
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
    await u.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(sent(server, 'GET', '/admin/dashboard').at(-1)!.query.get('range')).toBe('today'));
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('staff see only the actions they can take; an empty period says so', async () => {
    setup('/dashboard', { 'GET /admin/dashboard': () => [200, dash({ revenue: 0, orders: 0, salesSeries: dash().salesSeries.map((p) => ({ ...p, revenue: 0, orders: 0 })), ordersByStatus: {}, topProducts: [] })] }, 'STAFF');
    expect(await screen.findByText('No sales in this period yet.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Payment exceptions/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Orders to confirm/ })).toBeTruthy();
  });
});

describe('customers', () => {
  it('search and status asked of the server; the row links to the detail', async () => {
    const u = userEvent.setup();
    const { server } = setup('/customers');
    expect(await screen.findByRole('link', { name: 'Hema Rajan' })).toBeTruthy();
    await u.type(screen.getByLabelText('Search'), 'hema');
    await u.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(sent(server, 'GET', '/admin/customers').at(-1)!.query.get('q')).toBe('hema'));
    await u.selectOptions(screen.getByLabelText('Status'), 'BLOCKED');
    await waitFor(() => expect(sent(server, 'GET', '/admin/customers').at(-1)!.query.get('status')).toBe('BLOCKED'));
  });

  it('detail: the note limit on its field; Block needs a reason; Unblock', async () => {
    const u = userEvent.setup();
    let note: [number, unknown] = err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'adminNotes', message: 'Use at most 2,000 characters' }]);
    const { server, container } = setup('/customers/3', {
      'PATCH /admin/customers/3': () => note,
      'POST /admin/customers/3/block': () => [200, detail({ status: 'BLOCKED' })],
      'POST /admin/customers/3/unblock': () => [200, detail({ status: 'ACTIVE' })],
    });
    expect(await screen.findByRole('heading', { name: 'Hema Rajan' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'AQ10234' }).getAttribute('href')).toBe('/orders/7');
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
    await u.type(screen.getByLabelText('Not shown to the customer'), 'x'.repeat(2001));
    await u.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expectFieldError('Not shown to the customer', 'Use at most 2,000 characters'));
    expect(sent(server, 'PATCH', '/admin/customers/3')).toHaveLength(0);        // checked by the shared rule first
    await u.clear(screen.getByLabelText('Not shown to the customer'));
    await u.type(screen.getByLabelText('Not shown to the customer'), 'Prefers WhatsApp');
    await u.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expectFieldError('Not shown to the customer', 'Use at most 2,000 characters'));   // the server's answer lands on the field
    note = [200, detail({ adminNotes: 'Prefers WhatsApp' })];
    await u.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Note saved')).toBeTruthy();

    await u.click(screen.getByRole('button', { name: 'Block' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Block Hema Rajan?' }));
    await u.click(dialog.getByRole('button', { name: 'Block customer' }));
    await waitFor(() => expectFieldError('Reason (kept in the audit log)', 'Say why you are blocking this customer', dialog));
    await u.type(dialog.getByLabelText('Reason (kept in the audit log)'), 'Repeated chargebacks');
    await u.click(dialog.getByRole('button', { name: 'Block customer' }));
    expect(await screen.findByLabelText('Account status')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Account status').textContent).toBe('Blocked'));
    expect(sent(server, 'POST', '/admin/customers/3/block')[0]!.body).toEqual({ reason: 'Repeated chargebacks' });
    await u.click(screen.getByRole('button', { name: 'Unblock' }));
    await waitFor(() => expect(screen.getByLabelText('Account status').textContent).toBe('Active'));
  });

  it('STAFF: masked contact note, no edit or block controls', async () => {
    setup('/customers/3', { 'GET /admin/customers/3': () => [200, detail({ contactMasked: true, email: 'h***@example.com' })] }, 'STAFF');
    expect(await screen.findByText('Contact details are partly hidden for your role.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Block' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save note' })).toBeNull();
  });
});

describe('restock requests', () => {
  it('Notify now only for sizes in stock; already sent today; the waiting list and Remove', async () => {
    const u = userEvent.setup();
    let notify: [number, unknown] = [200, { queued: true, pending: 3 }];
    const { server, container } = setup('/restock-requests', {
      'POST /admin/restock-requests/notify': () => notify,
      'GET /admin/restock-requests/variants/101': () => [200, { data: [{ id: 9, email: 'asha@example.com', customerId: null, createdAt: '2026-09-20T06:00:00Z' }] }],
      'DELETE /admin/restock-requests/9': () => [204, undefined],
    });
    expect(await screen.findByRole('button', { name: 'Notify customers waiting for Epoxy Resin 500 ml' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Notify customers waiting for Epoxy Resin 1 L' })).toBeNull();   // sold out
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
    await u.click(screen.getByRole('button', { name: 'Notify customers waiting for Epoxy Resin 500 ml' }));
    expect(await screen.findByText('Emailing 3 waiting customers')).toBeTruthy();
    expect(sent(server, 'POST', '/admin/restock-requests/notify')[0]!.body).toEqual({ variantId: 101 });
    notify = [200, { queued: false, pending: 3 }];
    await u.click(screen.getByRole('button', { name: 'Notify customers waiting for Epoxy Resin 500 ml' }));
    expect(await screen.findByText('Already sent today; it goes out again tomorrow if needed')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Show the 3 customers waiting for Epoxy Resin 500 ml' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Waiting for Epoxy Resin (500 ml)' }));
    await u.click(await dialog.findByRole('button', { name: 'Remove request from asha@example.com' }));
    expect(await screen.findByText('Request removed')).toBeTruthy();
  });

  it('STAFF can see but not notify', async () => {
    setup('/restock-requests', {}, 'STAFF');
    expect(await screen.findByText('RES-500')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Notify customers/ })).toBeNull();
  });
});
