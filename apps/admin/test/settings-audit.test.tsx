// Task 6.5 in the admin against a fake API. Settings: each section on the shared rules (empty store name, GSTIN ↔
// state, rupee format, one way to pay, COD min ≤ max, limits at the boundary, one email per line), a password
// re-check before the save, a server refusal on its field, the body in paise; "no staff emails" warned. Audit Logs:
// filters (dates on the shared rule), record types from the API, an entry's changes field by field, "all by this
// person", the export after the password re-check. Staff: the role table from the shared permissions.
import { DEFAULT_SETTINGS, permissionsFor, type AdminSettingsView, type AuditDetail, type AuditRow } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

type Role = 'STAFF' | 'ADMIN' | 'SUPER_ADMIN';
const me = (role: Role) => ({ id: 7, name: 'Meera', email: 'meera@artq.in', role });
function setup(path: string, extra: Record<string, Handler> = {}, role: Role = 'SUPER_ADMIN') {
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: me(role) }],
    'GET /admin/me': () => [200, { user: me(role), permissions: permissionsFor(role) }],
    ...extra,
  });
  window.history.replaceState({}, '', path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const sent = (s: ReturnType<typeof setup>['server'], method: string, path: string) => s.calls.filter((c) => c.method === method && c.path === path);
const view = (o: Partial<AdminSettingsView> = {}): AdminSettingsView => ({
  STORE_INFO: { ...DEFAULT_SETTINGS.STORE_INFO, phone: '+91 98470 12345' }, PAYMENT: DEFAULT_SETTINGS.PAYMENT, ORDER: DEFAULT_SETTINGS.ORDER, TAX: DEFAULT_SETTINGS.TAX, NOTIFY: DEFAULT_SETTINGS.NOTIFY,
  states: [{ code: '29', name: 'Karnataka' }, { code: '32', name: 'Kerala' }],
  updated: { STORE_INFO: { at: '2026-10-09T06:00:00Z', by: 'Anu' }, PAYMENT: null, ORDER: null, TAX: null, NOTIFY: null }, ...o,
});
const section = (name: string) => within(screen.getByRole('region', { name }));

describe('settings', () => {
  it('store details: shared rules on the fields; password re-check; a server refusal on its field; saved', async () => {
    const u = userEvent.setup();
    let stepped = false;
    let reply: Handler = () => err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'stateCode', message: 'Choose the state' }]);
    const { server, container } = setup('/settings', {
      'GET /admin/settings': () => [200, view()],
      'POST /admin/auth/step-up': () => { stepped = true; return [200, { stepUpUntil: 'x' }]; },
      'PUT /admin/settings/STORE_INFO': (c) => (stepped ? reply(c) : err(401, 'STEP_UP_REQUIRED')),
    });
    expect(await screen.findByText('Changed 9 Oct 2026, 11:30 am by Anu')).toBeTruthy();
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
    const s = section('Store details');
    await u.clear(s.getByLabelText('Store name'));
    await u.type(s.getByLabelText('GSTIN (optional)'), '29abcde1234f1z5');
    await u.click(s.getByRole('button', { name: 'Save store details' }));
    await waitFor(() => expectFieldError('Store name', 'Enter the store name', s));
    expectFieldError('GSTIN (optional)', 'A GSTIN starts with its state’s code (32 for the state chosen)', s);
    await u.type(s.getByLabelText('Store name'), 'ArtQ');
    await u.selectOptions(s.getByLabelText('State'), '29');
    await u.click(s.getByRole('button', { name: 'Save store details' }));
    await u.type(await screen.findByLabelText('Password'), 'my-password');
    await u.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expectFieldError('State', 'Choose the state', s));
    reply = (c) => [200, view({ STORE_INFO: c.body as AdminSettingsView['STORE_INFO'] })];
    await u.click(s.getByRole('button', { name: 'Save store details' }));
    expect(await screen.findByText('Store details saved')).toBeTruthy();
    expect(sent(server, 'PUT', '/admin/settings/STORE_INFO').at(-1)!.body).toEqual({ name: 'ArtQ', legalName: null, gstin: '29ABCDE1234F1Z5', address: null, stateCode: '29', phone: '+91 98470 12345', email: null, whatsapp: null });
  });

  it('payments: rupee format, one way to pay, COD min ≤ max, the limits at the boundary; saved in paise', async () => {
    const u = userEvent.setup();
    const { server } = setup('/settings', { 'GET /admin/settings': () => [200, view()], 'PUT /admin/settings/PAYMENT': (c) => [200, view({ PAYMENT: c.body as AdminSettingsView['PAYMENT'] })] });
    await screen.findByRole('region', { name: 'Payments' });
    const s = section('Payments');
    await u.click(s.getByLabelText('Pay online (Razorpay)'));
    await u.click(s.getByLabelText('Cash on delivery'));
    await u.clear(s.getByLabelText('COD fee (₹)'));
    await u.type(s.getByLabelText('COD fee (₹)'), '40.555');
    await u.clear(s.getByLabelText('Hold stock for an unpaid online order (minutes)'));
    await u.type(s.getByLabelText('Hold stock for an unpaid online order (minutes)'), '4');
    await u.click(s.getByRole('button', { name: 'Save payments' }));
    // A format problem stops there; the shared rules (minutes 5–120) run once every box is readable.
    await waitFor(() => expectFieldError('COD fee (₹)', 'Use rupees with at most two decimals, e.g. 150 or 99.50', s));
    await u.clear(s.getByLabelText('COD fee (₹)'));
    await u.type(s.getByLabelText('COD fee (₹)'), '1000.01');
    await u.clear(s.getByLabelText('COD from order total (₹)'));
    await u.type(s.getByLabelText('COD from order total (₹)'), '6000');
    await u.click(s.getByRole('button', { name: 'Save payments' }));
    await waitFor(() => expectFieldError('Cash on delivery', 'Keep at least one way to pay switched on', s));
    expectFieldError('COD fee (₹)', 'At most ₹1,000', s);
    expectFieldError('COD up to order total (₹)', 'Use at least the minimum', s);
    expectFieldError('Hold stock for an unpaid online order (minutes)', 'At least 5 minutes', s);
    expect(sent(server, 'PUT', '/admin/settings/PAYMENT')).toEqual([]);
    await u.click(s.getByLabelText('Cash on delivery'));
    await u.clear(s.getByLabelText('COD fee (₹)'));
    await u.type(s.getByLabelText('COD fee (₹)'), '1000');
    await u.clear(s.getByLabelText('COD from order total (₹)'));
    await u.type(s.getByLabelText('COD from order total (₹)'), '200');
    await u.clear(s.getByLabelText('Hold stock for an unpaid online order (minutes)'));
    await u.type(s.getByLabelText('Hold stock for an unpaid online order (minutes)'), '120');
    await u.click(s.getByRole('button', { name: 'Save payments' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/settings/PAYMENT')).toHaveLength(1));
    expect(sent(server, 'PUT', '/admin/settings/PAYMENT')[0]!.body).toEqual({ razorpayEnabled: false, codEnabled: true, codFee: 100_000, codMin: 20_000, codMax: 500_000, pendingExpiryMinutes: 120 });
  });

  it('returns, tax and staff emails: limits, labels, one address per line; no addresses warned', async () => {
    const u = userEvent.setup();
    const { server } = setup('/settings', {
      'GET /admin/settings': () => [200, view()],
      'PUT /admin/settings/ORDER': () => [200, view()], 'PUT /admin/settings/TAX': () => [200, view()], 'PUT /admin/settings/NOTIFY': () => [200, view()],
    });
    expect(await screen.findByText('No addresses yet, so no staff emails are being sent.')).toBeTruthy();
    const r = section('Returns');
    await u.clear(r.getByLabelText('Return window (hours after delivery)'));
    await u.type(r.getByLabelText('Return window (hours after delivery)'), '721');
    await u.click(r.getByRole('button', { name: 'Save return window' }));
    await waitFor(() => expectFieldError('Return window (hours after delivery)', 'At most 720 hours (30 days)', r));
    await u.clear(r.getByLabelText('Return window (hours after delivery)'));
    await u.type(r.getByLabelText('Return window (hours after delivery)'), '720');
    await u.click(r.getByRole('button', { name: 'Save return window' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/settings/ORDER')[0]!.body).toEqual({ returnWindowHours: 720 }));
    const t = section('Tax');
    await u.selectOptions(t.getByLabelText('Shipping charge'), 'Not taxed (0 %)');
    await u.click(t.getByRole('button', { name: 'Save tax' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/settings/TAX')[0]!.body).toEqual({ shippingTaxRule: 'EXEMPT' }));
    const n = section('Staff emails');
    await u.type(n.getByLabelText('Addresses (one per line)'), 'owner@artq.in{Enter}not-an-email');
    await u.click(n.getByRole('button', { name: 'Save staff emails' }));
    await waitFor(() => expectFieldError('Addresses (one per line)', 'Enter a valid email address', n));
    await u.clear(n.getByLabelText('Addresses (one per line)'));
    await u.type(n.getByLabelText('Addresses (one per line)'), 'owner@artq.in{Enter}OWNER@artq.in');
    await u.click(n.getByRole('button', { name: 'Save staff emails' }));
    await waitFor(() => expectFieldError('Addresses (one per line)', 'Each address only once', n));
    await u.clear(n.getByLabelText('Addresses (one per line)'));
    await u.type(n.getByLabelText('Addresses (one per line)'), 'owner@artq.in{Enter}ops@artq.in, ');
    await u.click(n.getByRole('button', { name: 'Save staff emails' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/settings/NOTIFY')[0]!.body).toEqual({ adminEmails: ['owner@artq.in', 'ops@artq.in'] }));
  });

  it('ADMIN has no Settings', async () => {
    setup('/settings', {}, 'ADMIN');
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeTruthy();
  });
});

describe('audit logs', () => {
  afterEach(() => vi.unstubAllGlobals());
  const entry = (o: Partial<AuditRow> = {}): AuditRow => ({ id: '41', createdAt: '2026-10-09T06:00:00Z', action: 'setting.update', entity: 'setting', entityId: 'PAYMENT', actor: { id: 3, name: 'Anu', email: 'anu@artq.in' }, ip: '10.0.0.1', ...o });
  const detail: AuditDetail = { ...entry(), sessionId: '6f1c0f5e-0000-4000-8000-000000000000', userAgent: 'Mozilla/5.0', before: { codFee: 4000, codMin: 20_000, nested: { a: 1 } }, after: { codFee: 5000, codMin: 20_000, nested: { a: 2 }, added: true } };

  it('filters on the shared rule; record types from the API; an entry’s changes; all by this person; accessible', async () => {
    const u = userEvent.setup();
    const { server, container } = setup('/audit-logs', {
      'GET /admin/audit-logs': () => [200, { data: [entry(), entry({ id: '40', action: 'admin.login', entity: 'session', entityId: null, actor: null })], meta: { page: 1, limit: 25, total: 2, totalPages: 1 } }],
      'GET /admin/audit-logs/entities': () => [200, { data: ['order', 'session', 'setting'] }],
      'GET /admin/audit-logs/41': () => [200, detail],
    });
    expect(await screen.findByText('System')).toBeTruthy();
    expect(await screen.findByRole('option', { name: 'setting' })).toBeTruthy();
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
    await u.type(screen.getByLabelText('From (India date)'), '2026-10-09');
    await u.type(screen.getByLabelText('To'), '2026-10-01');
    await u.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expectFieldError('To', 'Use a day on or after “from”'));
    await u.clear(screen.getByLabelText('To'));
    await u.selectOptions(screen.getByLabelText('Record type'), 'setting');
    await u.type(screen.getByLabelText('Record id'), 'PAYMENT');
    await u.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      const q = sent(server, 'GET', '/admin/audit-logs').at(-1)!.query;
      expect([q.get('entity'), q.get('entityId'), q.get('from'), q.get('to')]).toEqual(['setting', 'PAYMENT', '2026-10-09', null]);
    });
    // The filtered results replace the rows: click once they have arrived, not on a row about to be swapped out.
    await waitFor(() => expect(screen.getByRole('table', { name: 'Audit log entries' }).closest('[aria-busy]')).toBeNull());
    await u.click(await screen.findByRole('button', { name: 'Open entry 41: setting.update' }));
    const d = within(await screen.findByRole('dialog', { name: 'Audit entry #41' }));
    const rows = (await d.findAllByRole('row')).slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent).join(' | '));
    expect(d.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['added', 'codFee', 'nested.a']);
    expect(rows).toEqual(['Before: (not set) | After: true', 'Before: 4000 | After: 5000', 'Before: 1 | After: 2']);
    expect(d.getByText('Mozilla/5.0')).toBeTruthy();
    await u.click(d.getByRole('button', { name: 'All by this person' }));
    await waitFor(() => expect(sent(server, 'GET', '/admin/audit-logs').at(-1)!.query.get('actorId')).toBe('3'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/Showing one person’s actions/)).toBeTruthy();
  });

  it('an event without changes says so; the export asks for the password, then saves the filtered CSV', async () => {
    const u = userEvent.setup();
    let stepped = false;
    const created = vi.fn(() => 'blob:csv');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const { server } = setup('/audit-logs?entity=session', {
      'GET /admin/audit-logs': () => [200, { data: [entry({ id: '40', action: 'admin.login', entity: 'session' })], meta: { page: 1, limit: 25, total: 1, totalPages: 1 } }],
      'GET /admin/audit-logs/entities': () => [200, { data: ['session'] }],
      'GET /admin/audit-logs/40': () => [200, { ...detail, id: '40', action: 'admin.login', before: null, after: null }],
      'POST /admin/auth/step-up': () => { stepped = true; return [200, { stepUpUntil: 'x' }]; },
      'GET /admin/audit-logs/export.csv': () => (stepped ? [200, 'id'] : err(401, 'STEP_UP_REQUIRED')),
    });
    await u.click(await screen.findByRole('button', { name: 'Open entry 40: admin.login' }));
    expect(await screen.findByText('This entry records an event; nothing was changed.')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Close' }));
    await u.click(screen.getByRole('button', { name: 'Export CSV' }));
    await u.type(await screen.findByLabelText('Password'), 'my-password');
    await u.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(sent(server, 'GET', '/admin/audit-logs/export.csv').at(-1)!.query.get('entity')).toBe('session');
  });
});

describe('staff', () => {
  it('the role table follows the shared permissions', async () => {
    const u = userEvent.setup();
    setup('/staff', { 'GET /admin/staff': () => [200, { data: [], meta: { page: 1, limit: 50, total: 0, totalPages: 1 } }] });
    await u.click(await screen.findByText('What each role can do'));
    const table = within(screen.getByRole('table', { name: 'Permissions by role' }));
    const cells = (label: string) => within(table.getByRole('rowheader', { name: label }).closest('tr')!).getAllByRole('cell').map((c) => c.firstElementChild!.getAttribute('aria-label'));
    expect(cells('Change prices')).toEqual(['No', 'Yes', 'Yes']);
    expect(cells('Change store, payment and tax settings (asks for the password)')).toEqual(['No', 'No', 'Yes']);
    expect(cells('Confirm, pack and ship orders')).toEqual(['Yes', 'Yes', 'Yes']);
  });
});
