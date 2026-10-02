// Product Types / Categories / Techniques pages (task 2.6) against a fake API.
import { permissionsFor } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

type Role = 'STAFF' | 'ADMIN' | 'SUPER_ADMIN';
afterEach(() => { vi.unstubAllGlobals(); });

const TYPES = [
  { id: 1, name: 'Resin', slug: 'resin', sortOrder: 0, isActive: true, showOnHome: true, showInMenu: true, image: { status: 'READY', url: 'https://cdn.test/1.webp' }, productCount: 12, categoryCount: 3 },
  { id: 2, name: 'Frames', slug: 'frames', sortOrder: 1, isActive: true, showOnHome: false, showInMenu: true, image: null, productCount: 0, categoryCount: 0 },
  { id: 3, name: 'Old Stock', slug: 'old-stock', sortOrder: 2, isActive: false, showOnHome: false, showInMenu: false, image: null, productCount: 0, categoryCount: 0 },
];
const CATEGORIES = [
  { id: 10, name: 'Epoxy', slug: 'epoxy', typeId: 1, isActive: true, sortOrder: 0, image: null, productCount: 8 },
  { id: 11, name: 'UV Resin', slug: 'uv-resin', typeId: 1, isActive: true, sortOrder: 1, image: null, productCount: 4 },
  { id: 20, name: 'Teak', slug: 'teak', typeId: 2, isActive: true, sortOrder: 0, image: null, productCount: 0 },
];

function setup(o: { path: string; role?: Role; extra?: Record<string, Handler> }) {
  const role = o.role ?? 'ADMIN';
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 7, name: 'Asha', email: 'a@artq.in', role } }],
    'GET /admin/me': () => [200, { user: { id: 7, name: 'Asha', email: 'a@artq.in', role }, permissions: permissionsFor(role) }],
    'GET /admin/product-types': () => [200, { data: TYPES, unassigned: 0, total: 12 }],
    'GET /admin/categories': (c) => [200, { data: c.query.get('typeId') ? CATEGORIES.filter((x) => String(x.typeId) === c.query.get('typeId')) : CATEGORIES }],
    'GET /admin/techniques': () => [200, { data: [{ id: 30, name: 'Resin Art', slug: 'resin-art', isActive: true, sortOrder: 0, image: null, productCount: 2 }] }],
    ...o.extra,
  });
  window.history.replaceState({}, '', o.path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const table = (name: string) => screen.findByRole('table', { name });
const rowOf = (name: string) => screen.getAllByText(name).find((e) => e.closest('tbody'))!.closest('tr')!;
const last = (server: ReturnType<typeof fakeServer>, method: string, path: string) => server.calls.filter((c) => c.method === method && c.path === path).at(-1);

describe('Product Types page', () => {
  it('lists types in display order with usage, status and a link to their products; passes axe', async () => {
    const { container } = setup({ path: '/product-types' });
    await within(await table('Product Types')).findByText('Resin');
    expect(within(rowOf('Resin')).getByRole('link', { name: '12 products' }).getAttribute('href')).toBe('/products?type=1');
    expect(within(rowOf('Resin')).getByText(/3 categories/)).toBeTruthy();
    expect(within(rowOf('Frames')).getByText('Menu')).toBeTruthy();
    expect(within(rowOf('Old Stock')).getByText('Off')).toBeTruthy();
    expect(within(rowOf('Old Stock')).getByText('Hidden from home and menu')).toBeTruthy();
    expect((within(rowOf('Resin')).getByRole('button', { name: 'Move Resin up' }) as HTMLButtonElement).disabled).toBe(true);
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });

  it('add: the API\'s messages under the fields; then a create with blank optional fields as null and no slug', async () => {
    const u = userEvent.setup();
    const { server } = setup({ path: '/product-types', extra: { 'POST /admin/product-types': (c) => [201, { id: 4, ...(c.body as object) }] } });
    await within(await table('Product Types')).findByText('Resin');
    await u.click(screen.getByRole('button', { name: 'Add product type' }));
    const dlg = await screen.findByRole('dialog', { name: 'Add product type' });
    await u.type(within(dlg).getByLabelText('Tile link (optional)'), 'javascript:alert(1)');
    await u.click(within(dlg).getByRole('button', { name: 'Add product type' }));
    await waitFor(() => expectFieldError('Name', 'Enter a name', within(dlg)));
    expectFieldError('Tile link (optional)', 'Use a path like /category/epoxy-resin or an https:// address', within(dlg));
    await u.type(within(dlg).getByLabelText('Name'), 'Moulds');
    await u.clear(within(dlg).getByLabelText('Tile link (optional)'));
    await u.click(within(dlg).getByLabelText('Show on the home page'));
    await u.click(within(dlg).getByRole('button', { name: 'Add product type' }));
    await screen.findByText('“Moulds” added');
    expect(last(server, 'POST', '/admin/product-types')!.body).toEqual({
      name: 'Moulds', description: null, isActive: true, metaTitle: null, metaDescription: null, imageMediaId: null, bannerMediaId: null,
      tileLinkUrl: null, showOnHome: false, showInMenu: true,
    });
  });

  it('edit loads the record and saves changes (a slug change says the old address keeps working)', async () => {
    const u = userEvent.setup();
    const detail = { id: 1, name: 'Resin', slug: 'resin', description: 'All resins', isActive: true, showOnHome: true, showInMenu: true, tileLinkUrl: null, imageMediaId: 5, bannerMediaId: null, metaTitle: null, metaDescription: null, sortOrder: 0, media: { 5: { renditions: { 160: 'https://cdn.test/5.webp' } } }, usage: { products: 12, categories: 3 } };
    const { server } = setup({ path: '/product-types', extra: { 'GET /admin/product-types/1': () => [200, detail], 'PATCH /admin/product-types/1': (c) => [200, { ...detail, ...(c.body as object) }] } });
    await within(await table('Product Types')).findByText('Resin');
    await u.click(within(rowOf('Resin')).getByRole('button', { name: 'Edit Resin' }));
    const dlg = await screen.findByRole('dialog', { name: 'Edit “Resin”' });
    expect(within(dlg).getByText('Changing it keeps the old address working (redirect).')).toBeTruthy();
    expect((within(dlg).getByLabelText('Description') as HTMLTextAreaElement).value).toBe('All resins');
    await u.clear(within(dlg).getByLabelText('URL slug'));
    await u.type(within(dlg).getByLabelText('URL slug'), 'resins');
    await u.click(within(dlg).getByRole('button', { name: 'Save' }));
    await screen.findByText('“Resin” saved');
    expect(last(server, 'PATCH', '/admin/product-types/1')!.body).toMatchObject({ slug: 'resins', imageMediaId: 5, description: 'All resins' });
  });

  it('✅ deleting a type in use: the API refusal is explained, with a link to its products', async () => {
    const u = userEvent.setup();
    setup({ path: '/product-types', extra: { 'DELETE /admin/product-types/1': () => err(409, 'TAXONOMY_IN_USE', '“Resin” is used by 12 products and 3 categories. Move them to another type (or archive the products) first, or turn the type off to hide it.', { products: 12, categories: 3 }) } });
    await within(await table('Product Types')).findByText('Resin');
    await u.click(within(rowOf('Resin')).getByRole('button', { name: 'Delete Resin' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Delete “Resin”?' })).getByRole('button', { name: 'Delete' }));
    const dlg = await screen.findByRole('dialog', { name: '“Resin” is still in use' });
    expect(within(dlg).getByText(/12 products and 3 categories/)).toBeTruthy();
    expect(within(dlg).getByRole('link', { name: 'See its products' }).getAttribute('href')).toBe('/products?type=1');
  });

  it('deleting an unused type; reordering sends the full new order', async () => {
    const u = userEvent.setup();
    const { server } = setup({ path: '/product-types', extra: { 'DELETE /admin/product-types/3': () => [204, undefined], 'PATCH /admin/product-types/reorder': () => [200, { ok: true }] } });
    await within(await table('Product Types')).findByText('Old Stock');
    await u.click(within(rowOf('Old Stock')).getByRole('button', { name: 'Delete Old Stock' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Delete “Old Stock”?' })).getByRole('button', { name: 'Delete' }));
    await screen.findByText('“Old Stock” deleted');
    await u.click(within(rowOf('Resin')).getByRole('button', { name: 'Move Resin down' }));
    await waitFor(() => expect(last(server, 'PATCH', '/admin/product-types/reorder')!.body).toEqual({ ids: [2, 1, 3] }));
  });

  it('an image is uploaded through the media pipeline and saved as the tile image', async () => {
    const u = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    // jsdom has no URL.createObjectURL; a subclass keeps the rest of URL working and is unstubbed after the test.
    vi.stubGlobal('URL', class extends URL { static override createObjectURL = () => 'blob:preview'; });
    const { server } = setup({ path: '/product-types', extra: {
      'POST /admin/media/presign': () => [201, { media: { id: 77 }, upload: { url: 'https://s3.test/77', headers: { 'Content-Type': 'image/png' } } }],
      'POST /admin/media/77/complete': () => [200, { id: 77 }],
      'POST /admin/product-types': (c) => [201, { id: 4, ...(c.body as object) }],
    } });
    await within(await table('Product Types')).findByText('Resin');
    await u.click(screen.getByRole('button', { name: 'Add product type' }));
    const dlg = await screen.findByRole('dialog', { name: 'Add product type' });
    await u.type(within(dlg).getByLabelText('Name'), 'Kits');
    await u.upload(within(dlg).getByLabelText('Tile image'), new File([new Uint8Array([1, 2])], 'kits.png', { type: 'image/png' }));
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Remove' })).toBeTruthy());
    await u.click(within(dlg).getByRole('button', { name: 'Add product type' }));
    await screen.findByText('“Kits” added');
    expect(last(server, 'POST', '/admin/product-types')!.body).toMatchObject({ name: 'Kits', imageMediaId: 77 });
  });
});

describe('Categories and Techniques', () => {
  it('categories: filter by type (request), reorder only within a type, and a type is required', async () => {
    const u = userEvent.setup();
    const { server } = setup({ path: '/categories' });
    await within(await table('Categories')).findByText('Epoxy');
    expect(within(rowOf('Teak')).getByText('Frames')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Move Epoxy down' })).toBeNull();
    expect(screen.getByText('Choose a product type to change the order of its categories.')).toBeTruthy();
    await u.selectOptions(screen.getByLabelText('Product type'), '1');
    await waitFor(() => expect(last(server, 'GET', '/admin/categories')!.query.get('typeId')).toBe('1'));
    expect(await screen.findByRole('button', { name: 'Move Epoxy down' })).toBeTruthy();
    await u.selectOptions(screen.getByLabelText('Product type'), '');
    await u.click(screen.getByRole('button', { name: 'Add category' }));
    const dlg = await screen.findByRole('dialog', { name: 'Add category' });
    await u.type(within(dlg).getByLabelText('Name'), 'Pigments');
    await u.type(within(dlg).getByLabelText('Default GST rate % (optional)'), '41');
    await u.click(within(dlg).getByRole('button', { name: 'Add category' }));
    await waitFor(() => expectFieldError('Product type', 'Choose a product type', within(dlg)));
    expectFieldError('Default GST rate % (optional)', 'GST rate cannot be more than 40 %', within(dlg));
  });

  it('techniques list with usage', async () => {
    setup({ path: '/techniques' });
    await within(await table('Techniques')).findByText('Resin Art');
    expect(within(rowOf('Resin Art')).getByText('2 products')).toBeTruthy();
  });

  it('STAFF (no catalog:write) gets "No access"', async () => {
    setup({ path: '/product-types', role: 'STAFF' });
    expect(await screen.findByText(/No access/i)).toBeTruthy();
  });
});
