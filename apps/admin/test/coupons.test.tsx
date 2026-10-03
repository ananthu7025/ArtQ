// Coupons module (task 4.3) against a fake API: list, the editor's validation (the shared couponBody after converting
// rupees, percent and dates), server field errors on their fields, locked discount once used, targets, delete.
import { permissionsFor, type CouponAdminView, type RedemptionView } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { couponForm, EMPTY_COUPON, fromCoupon, toBody, toLocal } from '../src/pages/coupons/coupon-form';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

type Role = 'STAFF' | 'ADMIN';
const me = (role: Role) => ({ id: 7, name: 'Asha', email: 'asha@artq.in', role });
const coupon = (o: Partial<CouponAdminView> & { id: number }): CouponAdminView => ({
  code: `CODE${o.id}`, title: 'Welcome offer', description: null, type: 'PERCENT', value: 10, maxDiscount: null, minOrderValue: 0, startsAt: null, endsAt: null,
  usageLimitTotal: null, usageLimitPerCustomer: 1, reservedCount: 0, redeemedCount: 0, firstOrderOnly: false, isPublic: false, isActive: true, appliesTo: 'ALL', targets: [],
  state: 'active', hasRedemptions: false, updatedAt: '2026-10-03T10:00:00Z', ...o,
});
const page = <T,>(rows: T[]) => [200, { data: rows, meta: { page: 1, limit: 25, total: rows.length, totalPages: 1 } }] as [number, unknown];

function setup(o: { path: string; role?: Role; extra?: Record<string, Handler> }) {
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: me(o.role ?? 'ADMIN') }],
    'GET /admin/me': () => [200, { user: me(o.role ?? 'ADMIN'), permissions: permissionsFor(o.role ?? 'ADMIN') }],
    'GET /admin/product-types': () => [200, { data: [{ id: 1, name: 'Resins' }, { id: 2, name: 'Pigments' }] }],
    'GET /admin/categories': () => [200, { data: [{ id: 11, name: 'Epoxy', typeId: 1 }, { id: 12, name: 'Mica', typeId: 2 }] }],
    ...o.extra,
  });
  window.history.replaceState({}, '', o.path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const noAxe = async (node: Element) => expect((await axe.run(node, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
const sent = (s: ReturnType<typeof setup>['server'], method: string, path: string) => s.calls.filter((c) => c.method === method && c.path === path);

describe('form conversion (coupon-form.ts)', () => {
  const v = (o: Partial<typeof EMPTY_COUPON>) => ({ ...EMPTY_COUPON, code: 'diwali', title: 'Diwali', ...o });
  const issues = (o: Partial<typeof EMPTY_COUPON>) => { const r = couponForm.safeParse(v(o)); return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message])); };
  it('rupees → paise, percent stays whole, empty limits → none, dates → instants; the shared rules apply', () => {
    expect(toBody(v({ type: 'FLAT', value: '150.50', minOrderValue: '999', usageLimitTotal: '', usageLimitPerCustomer: '2' }))).toMatchObject({ code: 'diwali', value: 15_050, minOrderValue: 99_900, usageLimitTotal: null, usageLimitPerCustomer: 2, maxDiscount: null });
    expect(toBody(v({ type: 'PERCENT', value: '15', maxDiscount: '250' }))).toMatchObject({ value: 15, maxDiscount: 25_000 });
    expect(toBody(v({ type: 'FREE_SHIPPING', value: '99', maxDiscount: '5' }))).toMatchObject({ value: 0, maxDiscount: null });
    expect(couponForm.parse(v({ value: '10', startsAt: '2026-11-01T10:00' }))).toMatchObject({ code: 'DIWALI', startsAt: new Date('2026-11-01T10:00').toISOString() });
    expect(toLocal(new Date('2026-11-01T10:05').toISOString())).toBe('2026-11-01T10:05');
  });
  it('format first (rupees, whole numbers), then the shared limits at their boundaries', () => {
    expect(issues({ type: 'FLAT', value: '1.234' })).toEqual({ value: 'Use rupees with at most two decimals, e.g. 150 or 99.50' });
    expect(issues({ value: '10.5' })).toEqual({ value: 'Use a whole percentage, e.g. 10' });
    expect(issues({ value: '10', usageLimitTotal: '2.5' })).toEqual({ usageLimitTotal: 'Use a whole number, or leave it empty for no limit' });
    expect(issues({ value: '100' })).toEqual({});
    expect(issues({ value: '101' })).toEqual({ value: 'Use a percentage from 1 to 100' });
    expect(issues({ type: 'FLAT', value: '1' })).toEqual({});
    expect(issues({ type: 'FLAT', value: '0.99' })).toEqual({ value: 'Use at least ₹1' });
    expect(issues({ value: '10', usageLimitTotal: '0' })).toEqual({ usageLimitTotal: 'Use 1 or more' });
    expect(issues({ value: '10', code: 'AB' })).toEqual({ code: 'Use at least 3 characters' });
    expect(issues({ value: '10', title: 'x'.repeat(121) })).toEqual({ title: 'Use at most 120 characters' });
    expect(issues({ value: '10', startsAt: '2026-11-02T00:00', endsAt: '2026-11-01T00:00' })).toEqual({ endsAt: 'End after the start' });
    expect(issues({ value: '10', appliesTo: 'TYPES' })).toEqual({ targetIds: 'Choose at least one' });
  });
  it('an existing coupon round-trips into the form', () => {
    const c = coupon({ id: 1, type: 'FLAT', value: 15_050, minOrderValue: 99_900, usageLimitPerCustomer: null, appliesTo: 'TYPES', targets: [{ id: 2, name: 'Pigments' }] });
    expect(fromCoupon(c)).toMatchObject({ type: 'FLAT', value: '150.50', minOrderValue: '999', usageLimitPerCustomer: '', targetIds: [2] });
    expect(couponForm.parse(fromCoupon(c))).toMatchObject({ value: 15_050, minOrderValue: 99_900, usageLimitPerCustomer: null, targetIds: [2] });
  });
});

describe('Coupons page', () => {
  it('lists code, discount, uses and status; filters go into the request; passes axe', async () => {
    const u = userEvent.setup();
    const rows = [coupon({ id: 1, code: 'WELCOME10', maxDiscount: 20_000, redeemedCount: 3, reservedCount: 1, usageLimitTotal: 100, isPublic: true }), coupon({ id: 2, code: 'OLD', type: 'FLAT', value: 5_000, state: 'expired' })];
    const { container, server } = setup({ path: '/coupons', extra: { 'GET /admin/coupons': () => page(rows) } });
    const table = await screen.findByRole('table', { name: 'Coupons' });
    const rowOf = (c: string) => within(table).getByRole('link', { name: c }).closest('tr')!;
    await within(table).findByRole('link', { name: 'WELCOME10' });
    expect(within(rowOf('WELCOME10')).getByText('10% off, up to ₹200')).toBeTruthy();
    expect(within(rowOf('WELCOME10')).getByText('3 used, 1 at checkout of 100')).toBeTruthy();
    expect(within(rowOf('OLD')).getByText('Expired')).toBeTruthy();
    expect(within(rowOf('OLD')).getByText('₹50 off')).toBeTruthy();
    await u.selectOptions(screen.getByLabelText('Status'), 'scheduled');
    await u.type(screen.getByLabelText('Search code or title'), 'diwali{Enter}');
    await waitFor(() => { const q = sent(server, 'GET', '/admin/coupons').at(-1)!.query; expect([q.get('state'), q.get('q')]).toEqual(['scheduled', 'diwali']); });
    await noAxe(container);
  });

  it('STAFF cannot open it (coupons:write)', async () => {
    setup({ path: '/coupons', role: 'STAFF' });
    expect(await screen.findByRole('heading', { name: /permission|not allowed|access/i })).toBeTruthy();
  });
});

describe('Coupon editor', () => {
  it('empty submit → messages under the fields; no request; passes axe', async () => {
    const u = userEvent.setup();
    const { container, server } = setup({ path: '/coupons/new' });
    await u.click(await screen.findByRole('button', { name: 'Create coupon' }));
    await waitFor(() => expectFieldError('Code', 'Enter a coupon code'));
    expectFieldError('Title', 'Enter a title customers will see');
    expectFieldError('Percentage (%)', 'Enter the discount');
    expect(sent(server, 'POST', '/admin/coupons')).toEqual([]);
    await noAxe(container);
  });

  it('creates a flat coupon on chosen categories with a window and limits; the body is in paise and instants; then opens it', async () => {
    const u = userEvent.setup();
    const created = coupon({ id: 5, code: 'MICA50', type: 'FLAT', value: 5_000 });
    const { server } = setup({ path: '/coupons/new', extra: { 'POST /admin/coupons': () => [201, created], 'GET /admin/coupons/5': () => [200, created], 'GET /admin/coupons/5/redemptions': () => page([]) } });
    await u.type(await screen.findByLabelText('Code'), 'mica50');
    await u.type(screen.getByLabelText('Title'), 'Mica week');
    await u.click(screen.getByLabelText('Amount off (₹)', { selector: 'input[type=radio]' }));
    await u.type(screen.getByLabelText('Amount off (₹)', { selector: 'input:not([type=radio])' }), '50');
    await u.type(screen.getByLabelText('Minimum order (₹, optional)'), '499.50');
    await u.selectOptions(screen.getByLabelText('Products'), 'CATEGORIES');
    await u.click(screen.getByRole('button', { name: 'Create coupon' }));
    await waitFor(() => expect(screen.getByText('Choose at least one')).toBeTruthy());     // targets are required for a scope
    await u.click(await screen.findByLabelText(/Mica/));
    await u.type(screen.getByLabelText('Ends (optional)'), '2026-12-31T23:59');
    await u.type(screen.getByLabelText('Total uses (optional)'), '200');
    await u.click(screen.getByLabelText('Show to customers'));
    await u.click(screen.getByRole('button', { name: 'Create coupon' }));
    await waitFor(() => expect(sent(server, 'POST', '/admin/coupons')).toHaveLength(1));
    expect(sent(server, 'POST', '/admin/coupons')[0]!.body).toEqual({
      code: 'MICA50', title: 'Mica week', description: null, type: 'FLAT', value: 5_000, maxDiscount: null, minOrderValue: 49_950, startsAt: null, endsAt: new Date('2026-12-31T23:59').toISOString(),
      usageLimitTotal: 200, usageLimitPerCustomer: 1, firstOrderOnly: false, isPublic: true, isActive: true, appliesTo: 'CATEGORIES', targetIds: [12],
    });
    expect(await screen.findByRole('heading', { name: 'MICA50' })).toBeTruthy();
    expect(screen.getByText('MICA50 created')).toBeTruthy();
  });

  it('server field errors land on their fields (code taken, total below uses)', async () => {
    const u = userEvent.setup();
    const { server } = setup({ path: '/coupons/new', extra: { 'POST /admin/coupons': () => err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'code', message: 'Another coupon (or a deleted one) uses this code' }]) } });
    await u.type(await screen.findByLabelText('Code'), 'TAKEN');
    await u.type(screen.getByLabelText('Title'), 'x');
    await u.type(screen.getByLabelText('Percentage (%)'), '5');
    await u.click(screen.getByRole('button', { name: 'Create coupon' }));
    await waitFor(() => expectFieldError('Code', 'Another coupon (or a deleted one) uses this code'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sent(server, 'POST', '/admin/coupons')).toHaveLength(1);
  });

  it('a used coupon: discount locked (and the API refusal explained); other fields save; redemptions listed; delete asks first', async () => {
    const u = userEvent.setup();
    const c = coupon({ id: 9, code: 'USED10', hasRedemptions: true, redeemedCount: 1, appliesTo: 'PRODUCTS', targets: [{ id: 40, name: 'Gold Mica' }] });
    const reds: RedemptionView[] = [{ id: 1, status: 'REDEEMED', overLimit: false, discount: 4_990, orderNumber: 'AQ10234', customer: { userId: null, email: 'hema@example.com' }, reservedAt: '2026-10-02T10:00:00Z', redeemedAt: '2026-10-02T10:05:00Z', releasedAt: null, reversedAt: null }];
    const { server } = setup({ path: '/coupons/9', extra: {
      'GET /admin/coupons/9': () => [200, c], 'GET /admin/coupons/9/redemptions': () => page(reds), 'GET /admin/coupons': () => page([]),
      'PUT /admin/coupons/9': (call) => [200, { ...c, ...(call.body as object), targets: c.targets }], 'DELETE /admin/coupons/9': () => [200, { ok: true }],
    } });
    expect(await screen.findByText(/its discount type and amount are locked/)).toBeTruthy();
    expect((screen.getByLabelText('Percentage (%)') as HTMLInputElement).disabled).toBe(true);
    expect(within(screen.getByRole('list', { name: 'Chosen products' })).getByText('Gold Mica')).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Orders that used USED10' });
    expect(within(table).getByText('AQ10234')).toBeTruthy();
    expect(within(table).getByText('hema@example.com')).toBeTruthy();
    await u.clear(screen.getByLabelText('Title'));
    await u.type(screen.getByLabelText('Title'), 'Renamed');
    await u.click(screen.getByRole('button', { name: 'Save coupon' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/coupons/9')).toHaveLength(1));
    expect(sent(server, 'PUT', '/admin/coupons/9')[0]!.body).toMatchObject({ title: 'Renamed', type: 'PERCENT', value: 10, appliesTo: 'PRODUCTS', targetIds: [40] });

    server.routes['PUT /admin/coupons/9'] = () => err(409, 'COUPON_IN_USE', 'x');
    await u.click(await screen.findByRole('button', { name: 'Save coupon' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/has been used, so its discount cannot change/);

    await u.click(screen.getByRole('button', { name: 'Delete coupon' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete USED10?' });
    expect(sent(server, 'DELETE', '/admin/coupons/9')).toEqual([]);
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sent(server, 'DELETE', '/admin/coupons/9')).toHaveLength(1));
    expect(await screen.findByRole('heading', { name: 'Coupons' })).toBeTruthy();
  });

  it('chosen products: search, add, remove', async () => {
    const u = userEvent.setup();
    const { server } = setup({ path: '/coupons/new', extra: {
      'GET /admin/products': () => page([{ id: 40, name: 'Gold Mica', type: { id: 2, name: 'Pigments' } }, { id: 41, name: 'Silver Mica', type: null }]),
      'POST /admin/coupons': () => [201, coupon({ id: 6 })], 'GET /admin/coupons/6': () => [200, coupon({ id: 6 })], 'GET /admin/coupons/6/redemptions': () => page([]),
    } });
    await u.selectOptions(await screen.findByLabelText('Products'), 'PRODUCTS');
    await u.type(screen.getByLabelText('Find products'), 'mica');
    await u.click(await screen.findByRole('button', { name: 'Add Gold Mica' }));
    await u.click(screen.getByRole('button', { name: 'Add Silver Mica' }));
    await u.click(within(screen.getByRole('list', { name: 'Chosen products' })).getByRole('button', { name: 'Remove Silver Mica' }));
    expect(sent(server, 'GET', '/admin/products').at(-1)!.query.get('q')).toBe('mica');
    await u.type(screen.getByLabelText('Code'), 'GOLD5');
    await u.type(screen.getByLabelText('Title'), 'Gold');
    await u.type(screen.getByLabelText('Percentage (%)'), '5');
    await u.click(screen.getByRole('button', { name: 'Create coupon' }));
    await waitFor(() => expect(sent(server, 'POST', '/admin/coupons')[0]?.body).toMatchObject({ appliesTo: 'PRODUCTS', targetIds: [40] }));
  });

  it('a deleted or unknown coupon says so', async () => {
    setup({ path: '/coupons/99', extra: { 'GET /admin/coupons/99': () => err(404, 'NOT_FOUND') } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/does not exist/);
  });
});
