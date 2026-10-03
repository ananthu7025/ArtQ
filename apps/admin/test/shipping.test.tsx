// Shipping Rates (task 4.4) against a fake API: rupee/gram text converted and checked with the shared schemas, errors
// under their fields (client and server), zones and slabs, state mapping, settings, pincode rules, CSV import, preview.
import { DEFAULT_SETTINGS, permissionsFor, type PincodeRuleView, type ShippingAdminView } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { previewForm, ruleForm, settingsForm, settingsToForm, zoneForm, zoneToForm, EMPTY_PREVIEW } from '../src/pages/shipping/forms';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

const view = (): ShippingAdminView => ({
  zones: [
    { id: 1, name: 'Kerala', extraPerKg: 4000, isActive: true, sortOrder: 1, slabs: [{ maxWeightG: 500, rate: 5000 }, { maxWeightG: 1000, rate: 7000 }], states: [{ id: 32, name: 'Kerala' }], usedByOrders: true },
    { id: 2, name: 'Rest of India', extraPerKg: 5500, isActive: true, sortOrder: 2, slabs: [{ maxWeightG: 5000, rate: 30_000 }], states: [{ id: 7, name: 'Delhi' }], usedByOrders: false },
  ],
  states: [{ id: 7, name: 'Delhi', zoneId: 2 }, { id: 32, name: 'Kerala', zoneId: 1 }, { id: 35, name: 'Andaman and Nicobar Islands', zoneId: null }],
  settings: { ...DEFAULT_SETTINGS.SHIPPING },
});
const rule = (o: Partial<PincodeRuleView> & { pincode: string }): PincodeRuleView => ({ place: { district: 'ERNAKULAM', state: 'Kerala' }, isServiceable: true, codAvailable: true, eddMinDays: null, eddMaxDays: null, note: null, source: 'MANUAL', updatedAt: '2026-10-03T10:00:00Z', ...o });
const page = <T,>(rows: T[]) => [200, { data: rows, meta: { page: 1, limit: 50, total: rows.length, totalPages: 1 } }] as [number, unknown];

function setup(o: { path: string; role?: 'STAFF' | 'ADMIN'; extra?: Record<string, Handler> }) {
  const role = o.role ?? 'ADMIN';
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 7, name: 'Asha', email: 'a@artq.in', role } }],
    'GET /admin/me': () => [200, { user: { id: 7, name: 'Asha', email: 'a@artq.in', role }, permissions: permissionsFor(role) }],
    'GET /admin/shipping': () => [200, view()],
    ...o.extra,
  });
  window.history.replaceState({}, '', o.path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const noAxe = async (node: Element) => expect((await axe.run(node, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
const sent = (s: ReturnType<typeof setup>['server'], method: string, path: string) => s.calls.filter((c) => c.method === method && c.path === path);

describe('form conversion (forms.ts → shared schemas)', () => {
  const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));
  it('zone: rupees → paise, grams whole; slab order and price rules from zoneBody', () => {
    const f = zoneToForm(view().zones[0]!);
    expect(f.slabs).toEqual([{ maxWeightG: '500', rate: '50' }, { maxWeightG: '1000', rate: '70' }]);
    expect(zoneForm.parse({ ...f, extraPerKg: '40.50' })).toMatchObject({ extraPerKg: 4050, slabs: [{ maxWeightG: 500, rate: 5000 }, { maxWeightG: 1000, rate: 7000 }] });
    expect(issues(zoneForm.safeParse({ ...f, slabs: [{ maxWeightG: '500.5', rate: '50' }] }))).toEqual({ 'slabs.0.maxWeightG': 'Use whole grams' });
    expect(issues(zoneForm.safeParse({ ...f, slabs: [{ maxWeightG: '500', rate: '50' }, { maxWeightG: '400', rate: '40' }] }))).toEqual({ 'slabs.1.maxWeightG': 'Must be heavier than the slab above', 'slabs.1.rate': 'A heavier slab cannot cost less' });
    expect(issues(zoneForm.safeParse({ ...f, extraPerKg: '10000' }))).toEqual({});
    expect(issues(zoneForm.safeParse({ ...f, extraPerKg: '10000.01' }))).toEqual({ extraPerKg: 'At most ₹10,000' });
    expect(issues(zoneForm.safeParse({ ...f, name: '', slabs: [] }))).toEqual({ name: 'Enter a zone name', slabs: 'Add at least one weight slab' });
  });
  it('settings: one text box of prefixes; a bad prefix is reported on the box', () => {
    const f = settingsToForm(DEFAULT_SETTINGS.SHIPPING);
    expect(f.airOnlyPincodePrefixes).toBe('744, 68255');
    expect(settingsForm.parse({ ...f, airOnlyPincodePrefixes: '744 68255,7371' }).airOnlyPincodePrefixes).toEqual(['744', '68255', '7371']);
    expect(issues(settingsForm.safeParse({ ...f, airOnlyPincodePrefixes: '744, x1' }))).toEqual({ airOnlyPincodePrefixes: 'Use 2 to 6 digits of a pincode, e.g. 744' });
    expect(issues(settingsForm.safeParse({ ...f, estimatedDays: { min: '5', max: '4' } }))).toEqual({ 'estimatedDays.max': 'Use at least the minimum' });
    expect(issues(settingsForm.safeParse({ ...f, packagingWeightG: '5001' }))).toEqual({ packagingWeightG: 'At most 5,000 g' });
    expect(settingsForm.parse({ ...f, freeThreshold: '1500' }).freeThreshold).toBe(150_000);
  });
  it('rule and preview', () => {
    expect(issues(ruleForm.safeParse({ pincode: '682011', isServiceable: false, codAvailable: true, eddMinDays: '', eddMaxDays: '', note: '' }))).toEqual({ codAvailable: 'Cash on delivery needs delivery to this pincode' });
    expect(issues(ruleForm.safeParse({ pincode: '0682', isServiceable: true, codAvailable: true, eddMinDays: '2', eddMaxDays: '', note: '' }))).toEqual({ pincode: 'Enter a 6-digit pincode' });
    expect(ruleForm.parse({ pincode: '682011', isServiceable: true, codAvailable: false, eddMinDays: '2', eddMaxDays: '3', note: ' x ' })).toEqual({ isServiceable: true, codAvailable: false, eddMinDays: 2, eddMaxDays: 3, note: 'x' });
    const p = { ...EMPTY_PREVIEW, pincode: '682011', weightG: '400', subtotal: '500' };
    expect(previewForm.parse(p)).toMatchObject({ weightG: 400, subtotal: 50_000, couponDiscount: 0, dimsCm: null });
    expect(issues(previewForm.safeParse({ ...p, length: '40' }))).toEqual({ width: 'Use centimetres with at most one decimal (all three, or none)', height: 'Use centimetres with at most one decimal (all three, or none)' });
    expect(issues(previewForm.safeParse({ ...p, length: '301', width: '1', height: '1' }))).toEqual({ length: expect.any(String) });
    expect(issues(previewForm.safeParse({ ...p, couponDiscount: '600' }))).toEqual({ couponDiscount: 'Cannot be more than the order value' });
  });
});

describe('Shipping Rates page', () => {
  it('STAFF cannot open it', async () => {
    setup({ path: '/shipping-rates', role: 'STAFF' });
    expect(await screen.findByRole('heading', { name: /permission|not allowed|access/i })).toBeTruthy();
  });

  it('zones: slabs in rupees and grams; a bad slab is marked under its field; a saved zone sends paise; passes axe', async () => {
    const u = userEvent.setup();
    const { container, server } = setup({ path: '/shipping-rates', extra: { 'PUT /admin/shipping/zones/1': () => [200, view()] } });
    const kerala = within(await screen.findByRole('region', { name: 'Kerala' }));
    expect((kerala.getByLabelText('Slab 2: rate (₹)') as HTMLInputElement).value).toBe('70');
    await noAxe(container);
    await u.clear(kerala.getByLabelText('Slab 2: up to (grams)'));
    await u.type(kerala.getByLabelText('Slab 2: up to (grams)'), '400');
    await u.click(kerala.getByRole('button', { name: 'Save zone' }));
    await waitFor(() => expectFieldError('Slab 2: up to (grams)', 'Must be heavier than the slab above', kerala));
    expect(sent(server, 'PUT', '/admin/shipping/zones/1')).toEqual([]);
    await u.clear(kerala.getByLabelText('Slab 2: up to (grams)'));
    await u.type(kerala.getByLabelText('Slab 2: up to (grams)'), '1000');
    await u.click(kerala.getByRole('button', { name: 'Add slab' }));
    await u.type(kerala.getByLabelText('Slab 3: up to (grams)'), '2000');
    await u.type(kerala.getByLabelText('Slab 3: rate (₹)'), '110.50');
    await u.click(kerala.getByRole('button', { name: 'Save zone' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/shipping/zones/1')).toHaveLength(1));
    expect(sent(server, 'PUT', '/admin/shipping/zones/1')[0]!.body).toEqual({ name: 'Kerala', extraPerKg: 4000, isActive: true, slabs: [{ maxWeightG: 500, rate: 5000 }, { maxWeightG: 1000, rate: 7000 }, { maxWeightG: 2000, rate: 11_050 }] });
    expect(await screen.findByText('Kerala saved')).toBeTruthy();
  });

  it('a server field error on a slab lands on that field; a zone in use cannot be deleted (explained)', async () => {
    const u = userEvent.setup();
    setup({ path: '/shipping-rates', extra: {
      'PUT /admin/shipping/zones/2': () => err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'slabs.0.rate', message: 'At most ₹10,000' }]),
      'DELETE /admin/shipping/zones/1': () => err(409, 'ZONE_IN_USE', 'Move its states to another zone first.'),
    } });
    const rest = within(await screen.findByRole('region', { name: 'Rest of India' }));
    await u.click(rest.getByRole('button', { name: 'Save zone' }));
    await waitFor(() => expectFieldError('Slab 1: rate (₹)', 'At most ₹10,000', rest));
    const kerala = within(screen.getByRole('region', { name: 'Kerala' }));
    await u.click(kerala.getByRole('button', { name: 'Delete zone' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Delete Kerala?' }));
    expect(dialog.getByText('Its states must move to another zone first.')).toBeTruthy();
    await u.click(dialog.getByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Move its states to another zone first.');
  });

  it('state mapping: shows states without a zone; saves only the changes', async () => {
    const u = userEvent.setup();
    const { server } = setup({ path: '/shipping-rates', extra: { 'PUT /admin/shipping/state-zones': () => [200, view()] } });
    const map = within(await screen.findByRole('region', { name: 'Which zone each state ships at' }));
    expect(map.getByText('1 without a zone.')).toBeTruthy();
    expect((map.getByRole('button', { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(true);
    await u.selectOptions(map.getByLabelText('Andaman and Nicobar Islands'), '2');
    await u.click(map.getByRole('button', { name: 'Save 1 change' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/shipping/state-zones')[0]?.body).toEqual({ assignments: [{ stateId: 35, zoneId: 2 }] }));
  });

  it('settings: saved in paise; a server error on one prefix shows on the prefix box', async () => {
    const u = userEvent.setup();
    const { server } = setup({ path: '/shipping-rates?tab=settings', extra: { 'PUT /admin/shipping/settings': () => [200, view()] } });
    const threshold = await screen.findByLabelText('Free shipping from (₹)');
    expect((threshold as HTMLInputElement).value).toBe('1000');
    await u.clear(threshold);
    await u.type(threshold, '1499.50');
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/shipping/settings')).toHaveLength(1));
    expect(sent(server, 'PUT', '/admin/shipping/settings')[0]!.body).toEqual({ ...DEFAULT_SETTINGS.SHIPPING, freeThreshold: 149_950 });
    server.routes['PUT /admin/shipping/settings'] = () => err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'airOnlyPincodePrefixes.1', message: 'Use 2 to 6 digits of a pincode, e.g. 744' }]);
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expectFieldError('Areas only reachable by air (pincode starts)', 'Use 2 to 6 digits of a pincode, e.g. 744'));
    await u.clear(screen.getByLabelText('Usual delivery: to (days)'));
    await u.type(screen.getByLabelText('Usual delivery: to (days)'), '2');
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expectFieldError('Usual delivery: to (days)', 'Use at least the minimum'));
  });

  it('delivery areas: list, add a rule (COD needs delivery), remove one', async () => {
    const u = userEvent.setup();
    const rows = [rule({ pincode: '110001', place: { district: 'NEW DELHI', state: 'Delhi' }, isServiceable: false, codAvailable: false, note: 'Courier strike' })];
    const { server } = setup({ path: '/shipping-rates?tab=areas', extra: {
      'GET /admin/shipping/pincodes': () => page(rows), 'PUT /admin/shipping/pincodes/682011': (c) => [200, rule({ pincode: '682011', ...(c.body as object) })],
      'DELETE /admin/shipping/pincodes/110001': () => [200, { ok: true }],
    } });
    const table = await screen.findByRole('table', { name: 'Pincode rules' });
    await within(table).findByText('110001');
    expect(within(table).getByText('Not delivered')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Add pincode' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add a pincode rule' }));
    await u.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expectFieldError('Pincode', 'Enter a 6-digit pincode', dialog));
    await u.type(dialog.getByLabelText('Pincode'), '682011');
    await u.click(dialog.getByLabelText('We deliver here'));
    await u.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(dialog.getByText('Cash on delivery needs delivery to this pincode')).toBeTruthy());
    await u.click(dialog.getByLabelText('We deliver here'));
    await u.click(dialog.getByLabelText('Cash on delivery available'));
    await u.type(dialog.getByLabelText('Delivery from (days)'), '2');
    await u.type(dialog.getByLabelText('Delivery to (days)'), '3');
    await u.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/shipping/pincodes/682011')[0]?.body).toEqual({ isServiceable: true, codAvailable: false, eddMinDays: 2, eddMaxDays: 3, note: null }));
    await u.click(await screen.findByRole('button', { name: 'Remove the rule for 110001' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Remove the rule for 110001?' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(sent(server, 'DELETE', '/admin/shipping/pincodes/110001')).toHaveLength(1));
  });

  it('CSV import: checked first (problems by line, nothing saved), then saved on request', async () => {
    const u = userEvent.setup();
    let result = { rows: 2, created: 0, updated: 0, unchanged: 0, errors: [{ line: 3, message: 'deliverable must be yes or no' }], saved: false };
    const { server } = setup({ path: '/shipping-rates?tab=areas', extra: { 'GET /admin/shipping/pincodes': () => page([]), 'POST /admin/shipping/pincodes/import': (c) => [200, (c.body as { dryRun: boolean }).dryRun ? result : { ...result, saved: true }] } });
    await u.click(await screen.findByRole('button', { name: 'Import CSV' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Import pincode rules' }));
    const file = new File(['pincode,deliverable,cod\n560001,yes,yes\n560002,maybe,no\n'], 'rules.csv', { type: 'text/csv' });
    await u.upload(dialog.getByLabelText('CSV file'), file);
    expect(await dialog.findByText('Line 3:')).toBeTruthy();
    expect((dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(sent(server, 'POST', '/admin/shipping/pincodes/import')[0]!.body).toEqual({ csv: 'pincode,deliverable,cod\n560001,yes,yes\n560002,maybe,no\n', dryRun: true });
    result = { rows: 2, created: 1, updated: 1, unchanged: 0, errors: [], saved: false };
    await u.upload(dialog.getByLabelText('CSV file'), new File(['fixed'], 'fixed.csv', { type: 'text/csv' }));
    expect(await dialog.findByText('fixed.csv: 2 rows. 1 new, 1 changed, 0 unchanged.')).toBeTruthy();
    await u.click(dialog.getByRole('button', { name: 'Save 2 pincodes' }));
    await waitFor(() => expect(sent(server, 'POST', '/admin/shipping/pincodes/import').at(-1)!.body).toEqual({ csv: 'fixed', dryRun: false }));
    expect(await screen.findByText('2 pincodes saved')).toBeTruthy();
  });

  it('preview: empty → messages under the fields; a quote shows what the customer pays; air-only noted', async () => {
    const u = userEvent.setup();
    const { server } = setup({ path: '/shipping-rates?tab=preview', extra: { 'POST /admin/shipping/preview': () => [200, {
      pincode: '744101', place: { district: 'SOUTH ANDAMAN', state: 'Andaman and Nicobar Islands' }, zone: { id: 3, name: 'Remote' }, surfaceAvailable: false,
      serviceability: { serviceable: true, codAvailable: true, fromRule: false },
      quote: { ok: true, actualWeightG: 550, chargeableWeightG: 550, rate: 14_000, shipping: 14_000, freeShippingApplied: false, heavySurcharge: 0, remainingForFree: 50_000 },
    }] } });
    await u.click(await screen.findByRole('button', { name: 'Calculate' }));
    await waitFor(() => expectFieldError('Pincode', 'Enter a 6-digit pincode'));
    expectFieldError('Packed weight per item (grams)', 'Enter the packed weight in grams');
    expectFieldError('Order value (₹)', 'Enter the order value');
    await u.type(screen.getByLabelText('Pincode'), '744101');
    await u.type(screen.getByLabelText('Packed weight per item (grams)'), '400');
    await u.type(screen.getByLabelText('Order value (₹)'), '500');
    await u.click(screen.getByRole('button', { name: 'Calculate' }));
    expect((await screen.findByText('Customer pays')).nextElementSibling!.textContent).toBe('₹140');
    expect(screen.getByText('Air-only area: resin cannot ship here.')).toBeTruthy();
    expect(screen.getByText('₹500 more for free shipping.')).toBeTruthy();
    expect(sent(server, 'POST', '/admin/shipping/preview')[0]!.body).toMatchObject({ pincode: '744101', weightG: 400, subtotal: 50_000, quantity: 1, shippingClass: 'STANDARD' });
  });

  it('tabs move with the arrow keys', async () => {
    const u = userEvent.setup();
    setup({ path: '/shipping-rates' });
    (await screen.findByRole('tab', { name: 'Rates & zones' })).focus();
    await u.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Delivery areas' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Delivery areas' }));
  });
});
