// Products page (task 2.4) against a fake API.
// ✅ Contract: no row renders "Unknown"; image states are rendered distinctly; STAFF sees read-only price cells and toggle.
import { permissionsFor, type ProductListRow } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';
import { TECHNIQUES, teakFrame } from './product-fixture';

type Role = 'STAFF' | 'ADMIN' | 'SUPER_ADMIN';
const row = (o: Partial<ProductListRow> & { id: number; name: string }): ProductListRow => ({
  serial: o.id, slug: o.name.toLowerCase().replace(/\W+/g, '-'), image: { state: 'READY', url: `https://cdn.test/${o.id}.webp` },
  type: { id: 1, name: 'Resin' }, category: { id: 10, name: 'Epoxy' }, status: 'DRAFT', isPublishable: true, readinessFailures: [],
  variantCount: 1, activeVariantCount: 1, priceRange: { min: 89_900, max: 89_900 }, available: 20, lowStock: false, oversold: false,
  flags: [], deletable: false, updatedAt: '2026-10-02T10:00:00Z', version: 1, ...o,
});
const ROWS: ProductListRow[] = [
  row({ id: 1, name: 'Ocean Pour Kit', status: 'ACTIVE', priceRange: { min: 19_000, max: 89_000 } }),
  row({ id: 2, name: 'Gold Gel Pigment', type: { id: 3, name: 'Pigments' }, image: { state: 'PROCESSING', url: null }, readinessFailures: ['no_image'], isPublishable: false, available: 0 }),
  row({ id: 3, name: 'Silver Mica', type: { id: 3, name: 'Pigments' }, image: { state: 'FAILED', url: null }, readinessFailures: ['no_image', 'no_tax'], isPublishable: false, lowStock: true, available: 2 }),
  row({ id: 4, name: 'Mystery Import Row', type: null, category: null, image: { state: 'MISSING', url: null }, priceRange: null, deletable: true, flags: ['SIZE_CONFLICT'], readinessFailures: ['taxonomy', 'no_image', 'has_flags'], isPublishable: false }),
];
const TYPES = { data: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: i, name: ['Resin', 'Frames', 'Pigments', 'Moulds', 'Tools', 'Kits', 'Glitter'][i - 1]!, slug: `t${i}`, sortOrder: i, isActive: true, productCount: i })), unassigned: 1, total: 29 };
const DETAIL = {
  ...teakFrame(), id: 1, name: 'Ocean Pour Kit', status: 'ACTIVE' as const,
  aggregates: { minPrice: 89_900, maxPrice: 89_900, maxMrp: 99_900, available: 20, activeVariants: 1 }, readiness: { ready: true, failures: [] },
  variants: [{ ...teakFrame().variants[0]!, thickness: null, id: 11, sku: 'OCEAN-1KG', label: '1 kg', size: '1 kg', color: null, weightG: 1100, weightSource: 'MEASURED', price: 89_900, mrp: 99_900, onHand: 25, reserved: 5, available: 20, isActive: true, version: 4 }],
};

function setup(o: { path?: string; role: Role; extra?: Record<string, Handler> }) {
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 7, name: 'Asha', email: 'a@artq.in', role: o.role } }],
    'GET /admin/me': () => [200, { user: { id: 7, name: 'Asha', email: 'a@artq.in', role: o.role }, permissions: permissionsFor(o.role) }],
    'GET /admin/products': () => [200, { data: ROWS, meta: { page: 1, limit: 20, total: 4, totalPages: 1 } }],
    'GET /admin/product-types': () => [200, TYPES],
    'GET /admin/categories': () => [200, { data: [{ id: 10, name: 'Epoxy', typeId: 1 }, { id: 20, name: 'Teak', typeId: 2 }] }],
    'GET /admin/products/1': () => [200, DETAIL],
    'GET /admin/techniques': () => [200, TECHNIQUES],
    ...o.extra,
  });
  window.history.replaceState({}, '', o.path ?? '/products');
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const table = () => screen.findByRole('table', { name: 'Products' });
const rowOf = (name: string) => screen.getByRole('link', { name }).closest('tr')!;
const last = (server: ReturnType<typeof fakeServer>, method: string, path: string) => server.calls.filter((c) => c.method === method && c.path === path).at(-1);

describe('✅ contract', () => {
  it('real type names, a neutral "Unassigned" badge, never "Unknown"', async () => {
    setup({ role: 'ADMIN' });
    await within(await table()).findByText('Ocean Pour Kit');
    expect(within(rowOf('Ocean Pour Kit')).getByText('Resin')).toBeTruthy();
    expect(within(rowOf('Gold Gel Pigment')).getByText('Pigments')).toBeTruthy();
    expect(within(rowOf('Mystery Import Row')).getByText('Unassigned')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/unknown/i);
  });

  it('image states are rendered distinctly, each in the same 48 px box', async () => {
    setup({ role: 'ADMIN' });
    await within(await table()).findByText('Ocean Pour Kit');
    const state = (name: string) => rowOf(name).querySelector('[data-image-state]')!;
    expect(state('Ocean Pour Kit').tagName).toBe('IMG');
    expect([state('Ocean Pour Kit'), state('Gold Gel Pigment'), state('Silver Mica'), state('Mystery Import Row')].map((e) => e.getAttribute('data-image-state'))).toEqual(['READY', 'PROCESSING', 'FAILED', 'MISSING']);
    expect(within(rowOf('Gold Gel Pigment')).getByText('Image of Gold Gel Pigment is processing')).toBeTruthy();
    expect(within(rowOf('Silver Mica')).getByText('Image of Silver Mica failed to process')).toBeTruthy();
    expect(within(rowOf('Mystery Import Row')).getByText('Mystery Import Row has no image')).toBeTruthy();
    for (const n of ['Gold Gel Pigment', 'Silver Mica', 'Mystery Import Row']) expect(state(n).className).toContain('h-12 w-12');
  });

  it('STAFF: read-only toggle and price cells (lock), no Add product, no selection, no Edit in the drawer', async () => {
    const u = userEvent.setup();
    setup({ role: 'STAFF' });
    await within(await table()).findByText('Ocean Pour Kit');
    const sw = within(rowOf('Ocean Pour Kit')).getByRole('switch');
    expect([sw.getAttribute('aria-checked'), (sw as HTMLButtonElement).disabled, sw.getAttribute('aria-label')]).toEqual(['true', true, 'Ocean Pour Kit is published (read-only)']);
    expect(screen.queryByRole('button', { name: 'Add product' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(within(rowOf('Ocean Pour Kit')).queryByRole('button', { name: /More actions/ })).toBeNull();
    await u.click(within(rowOf('Ocean Pour Kit')).getByRole('button', { name: 'Variants of Ocean Pour Kit' }));
    const drawer = await screen.findByRole('dialog', { name: 'Variants of Ocean Pour Kit' });
    expect(within(drawer).getByLabelText('Price is read-only for your role')).toBeTruthy();
    expect(within(drawer).getByLabelText('MRP is read-only for your role')).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'Edit OCEAN-1KG' })).toBeNull();
    expect(within(drawer).getByText('25 / 5')).toBeTruthy();
  });
});

describe('table, tabs and filters', () => {
  it('price range, stock colours, readiness, serials; passes axe', async () => {
    const { container } = setup({ role: 'ADMIN' });
    await within(await table()).findByText('Ocean Pour Kit');
    expect(within(rowOf('Ocean Pour Kit')).getByText('₹190–₹890')).toBeTruthy();
    expect(within(rowOf('Mystery Import Row')).getByText('No price')).toBeTruthy();
    expect(within(rowOf('Gold Gel Pigment')).getByText('0').className).toContain('text-danger-700');
    expect(within(rowOf('Silver Mica')).getAllByText('2').some((e) => e.className.includes('text-warning-700'))).toBe(true);   // low stock in amber
    expect(within(rowOf('Ocean Pour Kit')).getByText('Ready to publish')).toBeTruthy();
    expect(within(rowOf('Silver Mica')).getByRole('button', { name: '2 publication checks failing for Silver Mica' })).toBeTruthy();
    expect(within(rowOf('Mystery Import Row')).getByText(/SIZE_CONFLICT/)).toBeTruthy();
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });

  it('readiness popover lists what is missing and how to fix it', async () => {
    const u = userEvent.setup();
    setup({ role: 'ADMIN' });
    await within(await table()).findByText('Silver Mica');
    await u.click(within(rowOf('Silver Mica')).getByRole('button', { name: '2 publication checks failing for Silver Mica' }));
    expect(await screen.findByText('Not ready to publish')).toBeTruthy();
    expect(screen.getByText(/Add a cover image/)).toBeTruthy();
    expect(screen.getByText(/HSN code and GST rate/)).toBeTruthy();
  });

  it('type tabs: All + 5 types + More + Unassigned with counts; picking one filters the request', async () => {
    const u = userEvent.setup();
    const { server } = setup({ role: 'ADMIN' });
    const tabs = await screen.findByRole('group', { name: 'Product types' });
    await within(tabs).findByRole('button', { name: /Resin/ });
    expect(within(tabs).getAllByRole('button').map((b) => b.textContent!.trim())).toEqual(['All 29', 'Resin 1', 'Frames 2', 'Pigments 3', 'Moulds 4', 'Tools 5', 'More', 'Unassigned 1']);
    await u.click(within(tabs).getByRole('button', { name: /Pigments/ }));
    await waitFor(() => expect(last(server, 'GET', '/admin/products')!.query.get('type')).toBe('3'));
    expect(within(tabs).getByRole('button', { name: /Pigments/ }).getAttribute('aria-pressed')).toBe('true');
    await u.click(within(tabs).getByRole('button', { name: 'More types' }));
    await u.click(await screen.findByRole('menuitem', { name: /Glitter/ }));
    await waitFor(() => expect(last(server, 'GET', '/admin/products')!.query.get('type')).toBe('7'));
    await u.click(within(tabs).getByRole('button', { name: /Unassigned/ }));
    await waitFor(() => expect(last(server, 'GET', '/admin/products')!.query.get('type')).toBe('unassigned'));
  });

  it('filters and sort go into the URL and the request', async () => {
    const u = userEvent.setup();
    const { server } = setup({ role: 'ADMIN' });
    await within(await table()).findByText('Ocean Pour Kit');
    await u.selectOptions(screen.getByLabelText('Status'), 'ACTIVE');
    await u.selectOptions(screen.getByLabelText('Stock'), 'low');
    await u.selectOptions(screen.getByLabelText('Readiness'), 'no_image');
    await u.selectOptions(screen.getByLabelText('Image'), 'failed');
    await u.selectOptions(screen.getByLabelText('Sort by'), 'price');
    await u.type(screen.getByLabelText('Search name, SKU or slug'), 'mica{Enter}');
    await waitFor(() => {
      const q = last(server, 'GET', '/admin/products')!.query;
      expect(['status', 'stock', 'readiness', 'imageState', 'sort', 'q'].map((k) => q.get(k))).toEqual(['ACTIVE', 'low', 'no_image', 'failed', 'price', 'mica']);
    });
    expect(window.location.search).toContain('readiness=no_image');
  });
});

describe('activation toggle', () => {
  it('publishing a ready product succeeds; a refused one snaps back and lists what is missing', async () => {
    const u = userEvent.setup();
    const { server } = setup({ role: 'ADMIN', extra: {
      'POST /admin/products/3/publish': () => err(422, 'NOT_PUBLISHABLE', 'This product is not ready to publish', { failures: [{ code: 'no_image', check: 'Image', fix: 'x' }, { code: 'no_tax', check: 'Tax classification', fix: 'y' }] }),
      'POST /admin/products/1/unpublish': () => [200, {}],
    } });
    await within(await table()).findByText('Silver Mica');
    const sw = within(rowOf('Silver Mica')).getByRole('switch', { name: 'Publish Silver Mica' });
    await u.click(sw);
    const pop = await screen.findByRole('alertdialog', { name: 'Silver Mica cannot be published yet' });
    expect(within(pop).getByText(/Add a cover image/)).toBeTruthy();
    expect(within(pop).getByRole('link', { name: 'Fix in the editor' }).getAttribute('href')).toBe('/products/3');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await u.keyboard('{Escape}');
    await u.click(within(rowOf('Ocean Pour Kit')).getByRole('switch', { name: 'Unpublish Ocean Pour Kit' }));
    expect(await screen.findByText('“Ocean Pour Kit” is now a draft')).toBeTruthy();
    expect(last(server, 'POST', '/admin/products/1/unpublish')).toBeTruthy();
  });
});

describe('row actions and bulk', () => {
  it('Delete for a never-used draft, Archive otherwise; both confirm with the product name', async () => {
    const u = userEvent.setup();
    const { server } = setup({ role: 'ADMIN', extra: { 'DELETE /admin/products/4': () => [204, undefined], 'POST /admin/products/2/archive': () => [200, {}] } });
    await within(await table()).findByText('Mystery Import Row');
    await u.click(within(rowOf('Mystery Import Row')).getByRole('button', { name: 'More actions for Mystery Import Row' }));
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    await u.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dlg = await screen.findByRole('dialog', { name: 'Delete “Mystery Import Row”?' });
    await u.click(within(dlg).getByRole('button', { name: 'Delete' }));
    await screen.findByText('“Mystery Import Row” deleted');
    expect(last(server, 'DELETE', '/admin/products/4')).toBeTruthy();

    await u.click(within(rowOf('Gold Gel Pigment')).getByRole('button', { name: 'More actions for Gold Gel Pigment' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    await u.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Archive “Gold Gel Pigment”?' })).getByRole('button', { name: 'Archive' }));
    await screen.findByText('“Gold Gel Pigment” archived');
  });

  it('bulk publish reports per-row failures with what is missing', async () => {
    const u = userEvent.setup();
    const { server } = setup({ role: 'ADMIN', extra: {
      'POST /admin/products/bulk': () => [200, { results: [{ id: 1, ok: true }, { id: 3, ok: false, error: { code: 'NOT_PUBLISHABLE', message: 'This product is not ready to publish', details: { failures: [{ code: 'no_tax', check: 'Tax classification', fix: 'Approve tax.' }] } } }] }],
    } });
    await within(await table()).findByText('Silver Mica');
    await u.click(screen.getByRole('checkbox', { name: 'Select row 1' }));
    await u.click(screen.getByRole('checkbox', { name: 'Select row 3' }));
    await u.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Publish' }));
    const dlg = await screen.findByRole('dialog', { name: '1 done, 1 not changed' });
    expect(within(dlg).getByText('Silver Mica')).toBeTruthy();
    expect(within(dlg).getByText('Tax classification: Approve tax.')).toBeTruthy();
    expect(last(server, 'POST', '/admin/products/bulk')!.body).toEqual({ action: 'publish', ids: [1, 3] });
  });

  it('bulk set category asks for the category first', async () => {
    const u = userEvent.setup();
    const { server } = setup({ role: 'ADMIN', extra: { 'POST /admin/products/bulk': () => [200, { results: [{ id: 2, ok: true }] }] } });
    await within(await table()).findByText('Gold Gel Pigment');
    await u.click(screen.getByRole('checkbox', { name: 'Select row 2' }));
    await u.click(screen.getByRole('button', { name: 'Set category…' }));
    const dlg = await screen.findByRole('dialog', { name: 'Set category' });
    expect((within(dlg).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    await u.selectOptions(within(dlg).getByLabelText('Category'), await within(dlg).findByRole('option', { name: 'Teak (Frames)' }));
    await u.click(within(dlg).getByRole('button', { name: 'Apply' }));
    await screen.findByText('Set category: 1 updated');
    expect(last(server, 'POST', '/admin/products/bulk')!.body).toEqual({ action: 'setCategory', categoryId: 20, ids: [2] });
  });
});

describe('Add product (validation rule)', () => {
  it('empty name shows the field error; then creates the draft and opens it', async () => {
    const u = userEvent.setup();
    const { server } = setup({ role: 'ADMIN', extra: { 'POST /admin/products': (c) => [201, { id: 1, ...(c.body as object) }] } });
    await within(await table()).findByText('Ocean Pour Kit');
    await u.click(screen.getByRole('button', { name: 'Add product' }));
    const dlg = await screen.findByRole('dialog', { name: 'Add product' });
    await u.click(within(dlg).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expectFieldError('Name', 'Enter a product name', within(dlg)));
    await u.type(within(dlg).getByLabelText('Name'), 'Ocean Pour Kit');
    await u.selectOptions(within(dlg).getByLabelText('Product type (optional)'), '2');
    expect(within(dlg).getAllByRole('option').map((o) => o.textContent)).toContain('Teak');
    expect(within(dlg).getAllByRole('option').map((o) => o.textContent)).not.toContain('Epoxy');   // categories of the chosen type
    await u.click(within(dlg).getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByRole('heading', { name: 'Ocean Pour Kit' })).toBeTruthy();   // the product page
    expect(window.location.pathname).toBe('/products/1');
    expect(last(server, 'POST', '/admin/products')!.body).toEqual({ name: 'Ocean Pour Kit', typeId: 2 });
  });

  it('a 201-character name is refused by the form with the API\'s message; 200 is fine', async () => {
    const u = userEvent.setup();
    setup({ role: 'ADMIN' });
    await within(await table()).findByText('Ocean Pour Kit');
    await u.click(screen.getByRole('button', { name: 'Add product' }));
    const dlg = await screen.findByRole('dialog', { name: 'Add product' });
    await u.click(within(dlg).getByLabelText('Name'));
    await u.paste('n'.repeat(201));
    await u.click(within(dlg).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expectFieldError('Name', 'Use at most 200 characters', within(dlg)));
  });
});

describe('variant drawer (ADMIN)', () => {
  it('validates rupees with the pricing schema; saves content and price separately, in paise, with versions', async () => {
    const u = userEvent.setup();
    const { server } = setup({ role: 'ADMIN', extra: {
      'PATCH /admin/variants/11': (c) => [200, { ...DETAIL.variants[0], ...(c.body as object), version: 5 }],
      'PATCH /admin/variants/11/pricing': () => [200, { ...DETAIL.variants[0], version: 6 }],
    } });
    await within(await table()).findByText('Ocean Pour Kit');
    await u.click(within(rowOf('Ocean Pour Kit')).getByRole('button', { name: 'Variants of Ocean Pour Kit' }));
    const drawer = await screen.findByRole('dialog', { name: 'Variants of Ocean Pour Kit' });
    expect(within(drawer).queryByLabelText('Price is read-only for your role')).toBeNull();
    await u.click(within(drawer).getByRole('button', { name: 'Edit OCEAN-1KG' }));
    const form = within(drawer).getByRole('form', { name: 'Edit OCEAN-1KG' });
    const price = within(form).getByLabelText('Price (₹)');
    const mrp = within(form).getByLabelText('MRP (₹, optional)');
    await u.clear(price); await u.type(price, '899.555');
    await u.clear(mrp); await u.type(mrp, '500');
    await u.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expectFieldError('Price (₹)', 'Use rupees with at most two decimals, e.g. 899 or 899.50', within(form)));
    await u.clear(price); await u.type(price, '799.50');
    await u.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expectFieldError('MRP (₹, optional)', 'MRP must be at least the price', within(form)));
    await u.clear(mrp);
    const label = within(form).getByLabelText('Label');
    await u.clear(label); await u.type(label, '1 kg tub');
    await u.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(last(server, 'PATCH', '/admin/variants/11/pricing')).toBeTruthy());
    expect(last(server, 'PATCH', '/admin/variants/11')!.body).toEqual({ label: '1 kg tub', version: 4 });
    expect(last(server, 'PATCH', '/admin/variants/11/pricing')!.body).toEqual({ price: 79_950, mrp: null, version: 5 });
  });

  it('a live-product refusal explains which check would break', async () => {
    const u = userEvent.setup();
    setup({ role: 'ADMIN', extra: { 'PATCH /admin/variants/11': () => err(409, 'UNPUBLISH_FIRST', 'This change would make a live product fail a publication check. Unpublish it first, or fix the check.', { failures: [{ code: 'no_active_variant', check: 'Variants', fix: 'Turn on at least one variant.' }] }) } });
    await within(await table()).findByText('Ocean Pour Kit');
    await u.click(within(rowOf('Ocean Pour Kit')).getByRole('button', { name: 'Variants of Ocean Pour Kit' }));
    const drawer = await screen.findByRole('dialog', { name: 'Variants of Ocean Pour Kit' });
    await u.click(within(drawer).getByRole('button', { name: 'Edit OCEAN-1KG' }));
    await u.click(within(drawer).getByLabelText(/Active/));
    await u.click(within(drawer).getByRole('button', { name: 'Save' }));
    const alert = await within(drawer).findByRole('alert');
    expect(alert.textContent).toContain('Unpublish it first');
    expect(alert.textContent).toContain('Variants: Turn on at least one variant.');
  });
});
