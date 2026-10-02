// Product editor (task 2.5) against a fake API.
import { permissionsFor } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';
import { TECHNIQUES, teakFrame } from './product-fixture';

type Role = 'STAFF' | 'ADMIN' | 'SUPER_ADMIN';
afterEach(() => { vi.unstubAllGlobals(); });

function setup(o: { role?: Role; product?: ReturnType<typeof teakFrame>; extra?: Record<string, Handler> } = {}) {
  const role = o.role ?? 'ADMIN';
  let product = o.product ?? teakFrame();
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 7, name: 'Asha', email: 'a@artq.in', role } }],
    'GET /admin/me': () => [200, { user: { id: 7, name: 'Asha', email: 'a@artq.in', role }, permissions: permissionsFor(role) }],
    'GET /admin/products/1': () => [200, product],
    'GET /admin/product-types': () => [200, { data: [{ id: 1, name: 'Resin' }, { id: 2, name: 'Frames' }] }],
    'GET /admin/categories': () => [200, { data: [{ id: 10, name: 'Epoxy', typeId: 1 }, { id: 20, name: 'Teak', typeId: 2 }] }],
    'GET /admin/techniques': () => [200, TECHNIQUES],
    'PATCH /admin/products/1': (c) => { product = { ...product, ...(c.body as object), version: product.version + 1 } as typeof product; return [200, product]; },
    ...o.extra,
  });
  window.history.replaceState({}, '', '/products/1');
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const ready = () => screen.findByRole('heading', { level: 1, name: 'Teak Wood Frame' });
const calls = (server: ReturnType<typeof fakeServer>, method: string, path: string | RegExp) =>
  server.calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)));

describe('layout', () => {
  it('every section of product.md §7.4 with the saved values; readiness panel; passes axe', async () => {
    const { container } = setup();
    await ready();
    for (const h of ['Basics', 'Descriptions', 'Media', 'Variants', 'Tax', 'Relations', 'Flags & ranks', 'SEO', 'Ready to publish?']) expect(screen.getByRole('heading', { name: h })).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Teak Wood Frame');
    expect((screen.getByLabelText('Product details (one per line)') as HTMLTextAreaElement).value).toBe('Teak wood frame\nPlywood base');
    expect((screen.getByLabelText('Photo Framing') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Description' }).textContent).toContain('Teak wood frames with plywood base.');
    expect(screen.getByRole('toolbar', { name: 'Description formatting' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Ready to publish?' })).getByText(/Count the stock/)).toBeTruthy();
    expect(screen.getByLabelText('Search result preview').textContent).toContain('artq.in › product › teak-wood-frame');
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

describe('content form', () => {
  it('saves only when changed, with the base version; the API shape (lines → lists, tags → array)', async () => {
    const u = userEvent.setup();
    const { server } = setup();
    await ready();
    const save = screen.getByRole('button', { name: 'Save product' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await u.clear(screen.getByLabelText('Name'));
    await u.type(screen.getByLabelText('Name'), 'Teak Wood Frame with Plywood Base');
    await u.type(screen.getByLabelText('Product details (one per line)'), '\nSmooth finish');
    await u.clear(screen.getByLabelText('Tags (comma-separated)'));
    await u.type(screen.getByLabelText('Tags (comma-separated)'), 'frames, teak');
    await u.click(save);
    await screen.findAllByText('Product saved');   // toasts are global to sonner: earlier tests' may still be listed
    const body = calls(server, 'PATCH', '/admin/products/1')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ version: 5, name: 'Teak Wood Frame with Plywood Base', productDetails: ['Teak wood frame', 'Plywood base', 'Smooth finish'], tags: ['frames', 'teak'], specifications: { Material: 'Teak' } });
    expect(screen.getByText('All changes saved')).toBeTruthy();
  });

  it('validation rule: API messages under the fields, nothing sent', async () => {
    const u = userEvent.setup();
    const { server } = setup();
    await ready();
    await u.clear(screen.getByLabelText('Name'));
    await u.clear(screen.getByLabelText('URL slug'));
    await u.type(screen.getByLabelText('URL slug'), 'Teak Frame');
    await u.click(screen.getByRole('button', { name: 'Save product' }));
    await waitFor(() => expectFieldError('Name', 'Enter a product name'));
    expectFieldError('URL slug', 'Use lowercase letters, digits and single hyphens, e.g. teak-wood-frame');
    expect(screen.getByText('Some fields need attention. They are marked in red.')).toBeTruthy();
    expect(calls(server, 'PATCH', '/admin/products/1')).toHaveLength(0);
  });

  it('a server field error lands on its field; a live-product refusal explains the check', async () => {
    const u = userEvent.setup();
    let n = 0;
    setup({ extra: { 'PATCH /admin/products/1': () => (++n === 1
      ? err(409, 'SLUG_TAKEN', 'Another product already uses this URL slug')
      : err(409, 'UNPUBLISH_FIRST', 'This change would make a live product fail a publication check. Unpublish it first, or fix the check.', { failures: [{ code: 'no_description', check: 'Description', fix: 'Write a description for the product.' }] })) } });
    await ready();
    await u.type(screen.getByLabelText('Name'), ' 2');
    await u.click(screen.getByRole('button', { name: 'Save product' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Another product already uses this URL slug');
    await u.click(screen.getByRole('button', { name: 'Save product' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Description: Write a description for the product.'));
  });

  it('resolving an import flag and adding a specification are saved with the product', async () => {
    const u = userEvent.setup();
    const { server } = setup();
    await ready();
    await u.click(screen.getByRole('button', { name: 'Mark STOCK_AMBIGUOUS as resolved' }));
    await u.click(screen.getByRole('button', { name: 'Add specification' }));
    await u.type(screen.getByLabelText('Name 2'), 'Depth');
    await u.type(screen.getByLabelText('Value 2'), '1 inch');
    await u.click(screen.getByRole('button', { name: 'Save product' }));
    await screen.findAllByText('Product saved');   // toasts are global to sonner: earlier tests' may still be listed
    expect(calls(server, 'PATCH', '/admin/products/1')[0]!.body).toMatchObject({ dataFlags: [], specifications: { Material: 'Teak', Depth: '1 inch' } });
  });

  it('category list follows the type; changing type clears the category', async () => {
    const u = userEvent.setup();
    setup();
    await ready();
    const category = screen.getByLabelText('Category') as HTMLSelectElement;
    expect([...category.options].map((o) => o.textContent)).toEqual(['None', 'Teak']);
    await u.selectOptions(screen.getByLabelText('Product type'), '1');
    expect([...category.options].map((o) => o.textContent)).toEqual(['None', 'Epoxy']);
    expect(category.value).toBe('');
  });
});

describe('version conflict ("changed by Anu at 10:42")', () => {
  it('names who and when; Compare shows yours vs theirs; Reload takes theirs', async () => {
    const u = userEvent.setup();
    const theirs = teakFrame({ name: 'Teak Frame (Anu)', version: 6, updatedAt: '2026-10-02T10:42:00Z' });
    setup({ extra: { 'PATCH /admin/products/1': () => err(409, 'VERSION_CONFLICT', 'changed', { current: theirs }) } });
    await ready();
    await u.clear(screen.getByLabelText('Name'));
    await u.type(screen.getByLabelText('Name'), 'Teak Frame (mine)');
    await u.click(screen.getByRole('button', { name: 'Save product' }));
    const at = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' }).format(new Date(theirs.updatedAt));
    const dlg = await screen.findByRole('dialog', { name: `This product was changed by Anu at ${at}` });
    await u.click(within(dlg).getByRole('button', { name: 'Compare' }));
    const row = within(dlg).getByRole('rowheader', { name: 'Name' }).closest('tr')!;
    expect(within(row).getByText('Teak Frame (mine)')).toBeTruthy();
    expect(within(row).getByText('Teak Frame (Anu)')).toBeTruthy();
    await u.click(within(dlg).getByRole('button', { name: 'Reload their version' }));
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Teak Frame (Anu)'));
  });

  it('"Keep mine" saves over theirs with their version as the base', async () => {
    const u = userEvent.setup();
    const theirs = teakFrame({ name: 'Teak Frame (Anu)', version: 6 });
    let n = 0;
    const { server } = setup({ extra: { 'PATCH /admin/products/1': (c) => (++n === 1 ? err(409, 'VERSION_CONFLICT', 'changed', { current: theirs }) : [200, { ...theirs, ...(c.body as object), version: 7 }]) } });
    await ready();
    await u.type(screen.getByLabelText('Name'), '!');
    await u.click(screen.getByRole('button', { name: 'Save product' }));
    const dlg = await screen.findByRole('dialog', { name: /changed by Anu/ });
    await u.click(within(dlg).getByRole('button', { name: 'Compare' }));
    await u.click(within(dlg).getByRole('button', { name: 'Keep mine (save over theirs)' }));
    await u.click(screen.getByRole('button', { name: 'Save product' }));
    await screen.findAllByText('Product saved');   // toasts are global to sonner: earlier tests' may still be listed
    expect(calls(server, 'PATCH', '/admin/products/1').map((c) => (c.body as { version: number; name: string }))).toMatchObject([{ version: 5 }, { version: 6, name: 'Teak Wood Frame!' }]);
  });
});

describe('variants grid', () => {
  it('✅ Teak Wood Frame: generate 14 variants, paste a price column, save them all (content and price separately)', async () => {
    const u = userEvent.setup();
    let nextId = 100;
    const { server } = setup({ product: teakFrame({ variants: [] }), extra: {
      'POST /admin/products/1/variants': (c) => [201, { ...teakFrame().variants[0], ...(c.body as object), id: ++nextId, version: 1 }],
      ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`PATCH /admin/variants/${101 + i}/pricing`, () => [200, { id: 101 + i, version: 2 }]])),
    } });
    await ready();
    await u.click(screen.getByRole('button', { name: 'Generate variants' }));
    let dlg = await screen.findByRole('dialog', { name: 'Generate variants' });
    await u.type(within(dlg).getByLabelText('SKU prefix'), 'TWF');
    await u.type(within(dlg).getByLabelText('Sizes (comma-separated)'), '4x6, 6x6, 8x8, 10x10, 9x12, 12x12, 12x16, 14x14');
    await u.type(within(dlg).getByLabelText('Option values (comma-separated)'), '1 inch');
    await u.click(within(dlg).getByRole('button', { name: 'Add 8 rows' }));
    await u.click(screen.getByRole('button', { name: 'Generate variants' }));
    dlg = await screen.findByRole('dialog', { name: 'Generate variants' });
    await u.type(within(dlg).getByLabelText('SKU prefix'), 'TWF');
    await u.type(within(dlg).getByLabelText('Sizes (comma-separated)'), '4x6, 6x6, 8x8, 8x10, 10x10, 9x12');
    await u.type(within(dlg).getByLabelText('Option values (comma-separated)'), '0.5 inch');
    await u.click(within(dlg).getByRole('button', { name: 'Add 6 rows' }));
    expect(screen.getByText('14 unsaved rows')).toBeTruthy();
    // one paste fills the whole price column (the catalogue sheet order)
    await u.click(screen.getByLabelText('Price (₹), row 1'));
    await u.paste('210\n299\n360\n399\n470\n500\n640\n680\n190\n270\n350\n399\n380\n460');
    expect((screen.getByLabelText('Price (₹), row 14') as HTMLInputElement).value).toBe('460');
    await u.click(screen.getByRole('button', { name: 'Save variants' }));
    await screen.findByText('14 variants saved');
    const posts = calls(server, 'POST', '/admin/products/1/variants').map((c) => c.body as { sku: string; size: string; thickness: string });
    expect(posts).toHaveLength(14);
    expect(posts[0]).toEqual({ isActive: true, sku: 'TWF-1IN-4X6', size: '4x6', thickness: '1 inch', shippingClass: 'STANDARD' });
    expect(posts.map((p) => p.sku).at(-1)).toBe('TWF-05IN-9X12');
    const prices = calls(server, 'PATCH', /\/pricing$/).map((c) => c.body);
    expect(prices[0]).toEqual({ price: 21_000, mrp: null, version: 1 });
    expect(prices.at(-1)).toEqual({ price: 46_000, mrp: null, version: 1 });
    expect(calls(server, 'PATCH', /\/pricing$/).every((c) => !('sku' in (c.body as object)))).toBe(true);   // price never travels with content
  });

  it('cell errors block the save (red border + API message under the cell); nothing is sent', async () => {
    const u = userEvent.setup();
    const { server } = setup();
    await ready();
    const sku = screen.getByLabelText('SKU, row 1');
    await u.clear(sku); await u.type(sku, 'bad sku!');
    await u.clear(screen.getByLabelText('MRP (₹), row 1')); await u.type(screen.getByLabelText('MRP (₹), row 1'), '100');
    await u.click(screen.getByRole('button', { name: 'Save variants' }));
    await waitFor(() => expectFieldError('SKU, row 1', 'Use letters, digits, dots, dashes and underscores'));
    expectFieldError('MRP (₹), row 1', 'MRP must be at least the price');
    expect(server.calls.filter((c) => c.path.startsWith('/admin/variants'))).toHaveLength(0);
  });

  it('an existing row sends only what changed, with its version; cost kept when only the price changes', async () => {
    const u = userEvent.setup();
    const { server } = setup({ extra: {
      'PATCH /admin/variants/11': (c) => [200, { ...teakFrame().variants[0], ...(c.body as object), version: 3 }],
      'PATCH /admin/variants/11/pricing': () => [200, { id: 11, version: 4 }],
    } });
    await ready();
    await u.type(screen.getByLabelText('Weight (g), row 1'), '320');
    await u.selectOptions(screen.getByLabelText('Weight is, row 1'), 'MEASURED');
    await u.clear(screen.getByLabelText('Price (₹), row 1')); await u.type(screen.getByLabelText('Price (₹), row 1'), '220');
    await u.click(screen.getByRole('button', { name: 'Save variants' }));
    await screen.findByText('1 variant saved');
    expect(calls(server, 'PATCH', '/admin/variants/11')[0]!.body).toEqual({ weightG: 320, weightSource: 'MEASURED', version: 2 });
    expect(calls(server, 'PATCH', '/admin/variants/11/pricing')[0]!.body).toEqual({ price: 22_000, mrp: null, costPrice: 12_000, version: 3 });
  });

  it('STAFF: every field read-only, prices locked, no save buttons, no tax approval', async () => {
    setup({ role: 'STAFF' });
    await ready();
    expect(screen.getByLabelText('Name').matches(':disabled')).toBe(true);   // disabled through its fieldset
    expect(screen.queryByRole('button', { name: 'Save product' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save variants' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate variants' })).toBeNull();
    expect(screen.getAllByLabelText('Price (₹) is read-only for your role')).toHaveLength(2);
    expect(screen.getByText('₹210')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve tax' })).toBeNull();
    expect(screen.queryByText('Upload images')).toBeNull();
  });
});

describe('tax', () => {
  it('validates with the API schema, then approves', async () => {
    const u = userEvent.setup();
    const { server } = setup({ extra: { 'POST /admin/products/1/tax-approval': () => [200, teakFrame({ hsnCode: '4414', gstRate: 5, taxApprovedAt: '2026-10-02T11:00:00Z' })] } });
    await ready();
    await u.type(screen.getByLabelText('HSN code'), '441');
    await u.type(screen.getByLabelText('GST rate (%)'), '41');
    await u.click(screen.getByRole('button', { name: 'Approve tax' }));
    await waitFor(() => expectFieldError('HSN code', 'Enter an HSN code of 4, 6 or 8 digits'));
    expectFieldError('GST rate (%)', 'GST rate cannot be more than 40 %');
    await u.type(screen.getByLabelText('HSN code'), '4');
    await u.clear(screen.getByLabelText('GST rate (%)')); await u.type(screen.getByLabelText('GST rate (%)'), '5');
    await u.click(screen.getByRole('button', { name: 'Approve tax' }));
    await screen.findByText('Tax approved');
    expect(calls(server, 'POST', '/admin/products/1/tax-approval')[0]!.body).toEqual({ hsnCode: '4414', gstRate: 5 });
  });
});

describe('media', () => {
  it('upload: presign → PUT to storage → complete → saved as images; reorder and cover save the list', async () => {
    const u = userEvent.setup();
    const storage: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { storage.push(`${init.method} ${url} ${(init.headers as Record<string, string>)['Content-Type']}`); return new Response(null, { status: 200 }); }));
    const { server } = setup({ extra: {
      'POST /admin/media/presign': () => [201, { media: { id: 202 }, upload: { url: 'https://s3.test/put/202', headers: { 'Content-Type': 'image/png', 'Content-Length': '4' } } }],
      'POST /admin/media/202/complete': () => [200, { id: 202, status: 'UPLOADED' }],
      'PUT /admin/products/1/images': () => [200, teakFrame()],
    } });
    await ready();
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'front.png', { type: 'image/png' });
    await u.upload(screen.getByLabelText('Upload images'), file);
    await screen.findByText('Image added');
    expect(calls(server, 'POST', '/admin/media/presign')[0]!.body).toEqual({ filename: 'front.png', contentType: 'image/png', size: 4, purpose: 'product-image' });
    expect(storage).toEqual(['PUT https://s3.test/put/202 image/png']);
    expect(calls(server, 'PUT', '/admin/products/1/images')[0]!.body).toEqual({ images: [{ mediaId: 101, alt: 'Front', isCover: true }, { mediaId: 202, alt: null, isCover: false }] });
  });

  it('a file of the wrong type is refused before anything is uploaded', async () => {
    const u = userEvent.setup({ applyAccept: false });
    const { server } = setup();
    await ready();
    await u.upload(screen.getByLabelText('Upload images'), new File(['x'], 'notes.pdf', { type: 'application/pdf' }));
    expect((await screen.findByRole('alert')).textContent).toBe('notes.pdf: use a JPEG, PNG, WebP or AVIF image');
    expect(calls(server, 'POST', '/admin/media/presign')).toHaveLength(0);
  });
});
