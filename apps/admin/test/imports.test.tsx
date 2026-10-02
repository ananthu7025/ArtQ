// Imports pages (task 2.7) against a fake API.
import { permissionsFor } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import type { ImportRowView, ImportView } from '../src/pages/imports/parts';
import { fakeServer, type Handler } from './fake-server';

type Role = 'STAFF' | 'ADMIN' | 'SUPER_ADMIN';
afterEach(() => { vi.unstubAllGlobals(); });

const imp = (o: Partial<ImportView> = {}): ImportView => ({
  id: 5, fileName: 'ArtQ_Product_Import_All_Items.xlsx', status: 'VALIDATED', totalRows: 98, createdCount: 0, updatedCount: 0, unchangedCount: 0, reviewCount: 0, failedCount: 0,
  createdAt: '2026-10-03T09:00:00Z', validatedAt: '2026-10-03T09:00:05Z', completedAt: null, rows: { PENDING: 98 }, flaggedRows: 71, products: 64, ...o,
});
const row = (o: Partial<ImportRowView> & { id: number }): ImportRowView => ({
  rowNumber: o.id + 1, sku: `SKU-${o.id}`, productKey: 'k', status: 'PENDING', plan: 'create', productName: 'ArtQ Ultra Clear 2:1 Epoxy Resin', size: '300 gm',
  price: 49_900, mrp: null, stock: '500KG', flags: ['STOCK_AMBIGUOUS', 'WEIGHT_ESTIMATED'], messages: [{ code: 'STOCK_AMBIGUOUS', text: 'Stock “500KG” is not a count: imported as 0, to be counted' }], productId: null, ...o,
});
const page = (data: ImportRowView[]) => [200, { data, meta: { page: 1, limit: 50, total: data.length, totalPages: 1 } }] as [number, unknown];

function setup(o: { path: string; role?: Role; extra?: Record<string, Handler> }) {
  const role = o.role ?? 'ADMIN';
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 7, name: 'Asha', email: 'a@artq.in', role } }],
    'GET /admin/me': () => [200, { user: { id: 7, name: 'Asha', email: 'a@artq.in', role }, permissions: permissionsFor(role) }],
    'GET /admin/imports': () => [200, { data: [imp({ status: 'COMPLETED', createdCount: 98 })], meta: { page: 1, limit: 20, total: 1, totalPages: 1 } }],
    ...o.extra,
  });
  window.history.replaceState({}, '', o.path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const last = (server: ReturnType<typeof fakeServer>, method: string, path: string) => server.calls.filter((c) => c.method === method && c.path === path).at(-1);

describe('Imports list', () => {
  it('lists past imports with outcome; uploads a workbook, checks it and opens the import', async () => {
    const u = userEvent.setup();
    const storage: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { storage.push(`${init.method} ${url} ${(init.headers as Record<string, string>)['Content-Type']}`); return new Response(null, { status: 200 }); }));
    const { server, container } = setup({ path: '/imports', extra: {
      'POST /admin/media/presign': () => [201, { media: { id: 40 }, upload: { url: 'https://s3.test/40', headers: {} } }],
      'POST /admin/media/40/complete': () => [200, { id: 40 }],
      'POST /admin/imports': () => [201, imp({ status: 'UPLOADED', rows: {} })],
      'GET /admin/imports/5': () => [200, imp({ status: 'VALIDATING', rows: {} })],
    } });
    const table = await screen.findByRole('table', { name: 'Past imports' });
    expect(await within(table).findByText('98 created · 0 updated · 0 unchanged')).toBeTruthy();
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(res.violations.map((v) => v.id)).toEqual([]);
    await u.upload(screen.getByLabelText('Workbook (.xlsx, up to 5 MB)'), new File([new Uint8Array([80, 75, 3, 4])], 'ArtQ_Product_Import_All_Items.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    await u.click(screen.getByRole('button', { name: 'Check file' }));
    expect(await screen.findByText('Checking the file. This page updates by itself.')).toBeTruthy();
    expect(window.location.pathname).toBe('/imports/5');
    expect(last(server, 'POST', '/admin/media/presign')!.body).toMatchObject({ purpose: 'catalog-import', size: 4 });
    expect(storage).toEqual(['PUT https://s3.test/40 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    expect(last(server, 'POST', '/admin/imports')!.body).toEqual({ kind: 'CATALOG', fileMediaId: 40, createMissing: true, fileName: 'ArtQ_Product_Import_All_Items.xlsx' });
  });

  it('a file that is not .xlsx is refused before upload; no file at all says what to do', async () => {
    const u = userEvent.setup({ applyAccept: false });
    const { server } = setup({ path: '/imports' });
    await screen.findByRole('table', { name: 'Past imports' });
    await u.click(screen.getByRole('button', { name: 'Check file' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Choose the .xlsx file to import');
    await u.upload(screen.getByLabelText('Workbook (.xlsx, up to 5 MB)'), new File(['a,b'], 'catalogue.csv', { type: 'text/csv' }));
    await u.click(screen.getByRole('button', { name: 'Check file' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('catalogue.csv: choose an Excel .xlsx file'));
    expect(server.calls.some((c) => c.path === '/admin/media/presign')).toBe(false);
  });

  it('STAFF (inventory only) does not get the catalogue upload', async () => {
    setup({ path: '/imports', role: 'STAFF' });
    expect(await screen.findByText(/Inventory count imports arrive/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check file' })).toBeNull();
  });
});

describe('One import', () => {
  it('after the check: summary, flagged rows in plain words, confirm with a dialog', async () => {
    const u = userEvent.setup();
    let status: ImportView['status'] = 'VALIDATED';
    const { server, container } = setup({ path: '/imports/5', extra: {
      'GET /admin/imports/5': () => [200, imp({ status })],
      'GET /admin/imports/5/rows': () => page([row({ id: 1 }), row({ id: 2, sku: 'ESS-BLOW-TORCH', productName: 'Blow Torch', price: null, stock: 3, flags: ['PRICE_MISSING'], messages: [] })]),
      'POST /admin/imports/5/confirm': () => { status = 'IMPORTING'; return [200, imp({ status })]; },
    } });
    await screen.findByText('Checked: ready to import');
    const summary = screen.getByRole('region', { name: 'Summary' });
    expect(within(summary).getByText('64')).toBeTruthy();
    expect(within(summary).getByText('71')).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Import rows' });
    expect(within(table).getByText('Stock not a count')).toBeTruthy();
    expect(within(table).getByText('None')).toBeTruthy();                 // missing price shown, not ₹0
    expect(within(table).getAllByText('New')).toHaveLength(2);
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => v.id)).toEqual([]);
    await u.click(screen.getByRole('button', { name: 'With flags' }));
    await waitFor(() => expect(last(server, 'GET', '/admin/imports/5/rows')!.query.get('flagged')).toBe('1'));
    await u.click(screen.getByRole('button', { name: 'Import 98 rows' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Import 98 rows?' })).getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Import started')).toBeTruthy();
    expect(last(server, 'POST', '/admin/imports/5/confirm')).toBeTruthy();
  });

  it('while importing: progress; when done with review rows: Apply or Skip each', async () => {
    const u = userEvent.setup();
    const { server } = setup({ path: '/imports/5', extra: {
      'GET /admin/imports/5': () => [200, imp({ status: 'IMPORTING', rows: { CREATED: 49, PENDING: 49 } })],
      'GET /admin/imports/5/rows': () => page([row({ id: 1, status: 'CREATED' })]),
    } });
    expect(await screen.findByText('49 of 98 rows (50 %)')).toBeTruthy();
    server.routes['GET /admin/imports/5'] = () => [200, imp({ status: 'COMPLETED_WITH_ERRORS', rows: { CREATED: 96, NEEDS_REVIEW: 2 }, reviewCount: 2 })];
    server.routes['GET /admin/imports/5/rows'] = () => page([row({ id: 3, status: 'NEEDS_REVIEW', messages: [{ code: 'CHANGED_SINCE_VALIDATION', text: 'The variant was changed in the admin after this file was checked' }] }), row({ id: 4, status: 'NEEDS_REVIEW' })]);
    server.routes['POST /admin/imports/5/rows/3/resolve'] = () => [200, imp({ status: 'COMPLETED_WITH_ERRORS' })];
    server.routes['POST /admin/imports/5/rows/4/resolve'] = () => [200, imp({ status: 'COMPLETED_WITH_ERRORS' })];
    expect(await screen.findByText('Completed: some rows need attention', {}, { timeout: 4000 })).toBeTruthy();
    await u.click(await screen.findByRole('button', { name: 'Apply row 4' }));
    await screen.findByText('Row 4 applied');
    await u.click(screen.getByRole('button', { name: 'Skip row 5' }));
    await screen.findByText('Row 5 skipped');
    expect(last(server, 'POST', '/admin/imports/5/rows/3/resolve')!.body).toEqual({ action: 'apply' });
    expect(last(server, 'POST', '/admin/imports/5/rows/4/resolve')!.body).toEqual({ action: 'skip' });
  });

  it('a failed check explains what to do; no rows are requested', async () => {
    const { server } = setup({ path: '/imports/5', extra: { 'GET /admin/imports/5': () => [200, imp({ status: 'FAILED', totalRows: 0 })] } });
    expect(await screen.findByText(/The file could not be imported/)).toBeTruthy();
    expect(server.calls.some((c) => c.path === '/admin/imports/5/rows')).toBe(false);
    expect(screen.queryByRole('button', { name: /Result file/ })).toBeNull();
  });
});
