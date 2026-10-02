// Inventory page (task 2.8) against a fake API.
import { permissionsFor } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import type { StockRow } from '../src/pages/inventory/InventoryPage';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

type Role = 'STAFF' | 'ADMIN';
const row = (o: Partial<StockRow> & { variantId: number; sku: string }): StockRow => ({
  label: '1 kg', product: { id: 1, name: 'ArtQ Ultra Clear 2:1 Epoxy Resin', status: 'DRAFT' }, onHand: 10, reserved: 0, available: 10,
  lowStockThreshold: 5, countedAt: '2026-10-03T09:00:00Z', isActive: true, ...o,
});
const ROWS = [
  row({ variantId: 1, sku: 'RES-21-300G', onHand: 1, reserved: 3, available: -2 }),
  row({ variantId: 2, sku: 'RES-21-750G', onHand: 4, available: 4 }),
  row({ variantId: 3, sku: 'RES-21-1.5KG', onHand: 0, available: 0, countedAt: null }),
  row({ variantId: 4, sku: 'RES-21-3KG', onHand: 30, available: 30 }),
];

function setup(o: { role?: Role; extra?: Record<string, Handler> } = {}) {
  const role = o.role ?? 'STAFF';
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 7, name: 'Sanju', email: 's@artq.in', role } }],
    'GET /admin/me': () => [200, { user: { id: 7, name: 'Sanju', email: 's@artq.in', role }, permissions: permissionsFor(role) }],
    'GET /admin/inventory': () => [200, { data: ROWS, meta: { page: 1, limit: 50, total: 4, totalPages: 1 } }],
    ...o.extra,
  });
  window.history.replaceState({}, '', '/inventory');
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const table = () => screen.findByRole('table', { name: 'Stock' });
const rowOf = (sku: string) => screen.getByText(sku).closest('tr')!;
const last = (server: ReturnType<typeof fakeServer>, method: string, path: string) => server.calls.filter((c) => c.method === method && c.path === path).at(-1);

describe('Inventory page', () => {
  it('on hand / reserved / available; oversold, low and not-counted states are visible; passes axe', async () => {
    const { container } = setup();
    await within(await table()).findByText('RES-21-300G');
    expect(within(rowOf('RES-21-300G')).getByText('Oversold')).toBeTruthy();
    expect(within(rowOf('RES-21-300G')).getByText('-2').className).toContain('text-danger-700');
    expect(within(rowOf('RES-21-750G')).getByText('4', { selector: 'span.tabular-nums.font-semibold' }).className).toContain('text-warning-700');
    expect(within(rowOf('RES-21-1.5KG')).getByText('Not counted')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Import counts/ }).getAttribute('href')).toBe('/imports?kind=INVENTORY');
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => v.id)).toEqual([]);
  });

  it('filters and search go into the request', async () => {
    const u = userEvent.setup();
    const { server } = setup();
    await within(await table()).findByText('RES-21-300G');
    await u.click(screen.getByRole('button', { name: 'Oversold' }));
    await waitFor(() => expect(last(server, 'GET', '/admin/inventory')!.query.get('stock')).toBe('oversold'));
    await u.type(screen.getByLabelText('Search SKU or product'), 'res-21{Enter}');
    await waitFor(() => expect(last(server, 'GET', '/admin/inventory')!.query.get('q')).toBe('res-21'));
    // Searching keeps the chosen filter, and choosing a filter keeps the search.
    expect(last(server, 'GET', '/admin/inventory')!.query.get('stock')).toBe('oversold');
    expect(screen.getByRole('button', { name: 'Oversold' }).getAttribute('aria-pressed')).toBe('true');
    await u.click(screen.getByRole('button', { name: 'Out of stock' }));
    await waitFor(() => expect(last(server, 'GET', '/admin/inventory')!.query.get('stock')).toBe('out'));
    expect(last(server, 'GET', '/admin/inventory')!.query.get('q')).toBe('res-21');
  });

  it('change stock: the API\'s rules under the fields, a preview of the result, then the request (no price fields anywhere)', async () => {
    const u = userEvent.setup();
    const { server } = setup({ extra: { 'POST /admin/inventory/adjustments': () => [200, { data: [], oversold: [] }] } });
    await within(await table()).findByText('RES-21-3KG');
    await u.click(within(rowOf('RES-21-3KG')).getByRole('button', { name: 'Change stock of RES-21-3KG' }));
    const dlg = await screen.findByRole('dialog', { name: 'Change stock: RES-21-3KG' });
    expect(within(dlg).queryByLabelText(/price|mrp/i)).toBeNull();
    await u.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expectFieldError('Counted quantity', 'Enter a quantity', within(dlg)));
    await u.click(within(dlg).getByLabelText('Write off damaged'));
    await u.type(within(dlg).getByLabelText('Units to write off'), '2');
    expect(within(dlg).getByRole('status').textContent).toBe('On hand 30 → 28');
    await u.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expectFieldError('Reason', 'Give a reason', within(dlg)));
    await u.click(within(dlg).getByLabelText('Add or remove'));
    await u.clear(within(dlg).getByLabelText('Change (+/−)'));
    await u.type(within(dlg).getByLabelText('Change (+/−)'), '0');
    await u.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expectFieldError('Change (+/−)', 'Enter a change other than 0 (use − to remove units)', within(dlg)));
    await u.clear(within(dlg).getByLabelText('Change (+/−)'));
    await u.type(within(dlg).getByLabelText('Change (+/−)'), '-5');
    await u.type(within(dlg).getByLabelText('Reason'), 'Returned to supplier');
    await u.click(within(dlg).getByRole('button', { name: 'Save' }));
    await screen.findByText('RES-21-3KG updated');
    expect(last(server, 'POST', '/admin/inventory/adjustments')!.body).toEqual({ rows: [{ variantId: 4, kind: 'ADJUSTMENT', quantity: -5, note: 'Returned to supplier' }] });
  });

  it('counting below what is reserved warns before saving; the server result says it is oversold', async () => {
    const u = userEvent.setup();
    setup({ extra: { 'POST /admin/inventory/adjustments': () => [200, { data: [], oversold: [2] }] } });
    ROWS[1] = { ...ROWS[1]!, reserved: 3, available: 1 };
    await within(await table()).findByText('RES-21-750G');
    await u.click(within(rowOf('RES-21-750G')).getByRole('button', { name: 'Change stock of RES-21-750G' }));
    const dlg = await screen.findByRole('dialog', { name: 'Change stock: RES-21-750G' });
    await u.type(within(dlg).getByLabelText('Counted quantity'), '1');
    expect(within(dlg).getByRole('status').textContent).toContain('below the 3 units reserved by open orders');
    await u.click(within(dlg).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('RES-21-750G is now oversold: an exception was raised for the team')).toBeTruthy();
    ROWS[1] = { ...ROWS[1]!, reserved: 0, available: 4 };
  });

  it('a refusal from the server (below zero) is shown in the dialog', async () => {
    const u = userEvent.setup();
    setup({ extra: { 'POST /admin/inventory/adjustments': () => err(422, 'INVALID_ADJUSTMENT', 'This would leave less than 0 units on hand') } });
    await within(await table()).findByText('RES-21-3KG');
    await u.click(within(rowOf('RES-21-3KG')).getByRole('button', { name: 'Change stock of RES-21-3KG' }));
    const dlg = await screen.findByRole('dialog', { name: 'Change stock: RES-21-3KG' });
    await u.type(within(dlg).getByLabelText('Counted quantity'), '3');
    await u.click(within(dlg).getByRole('button', { name: 'Save' }));
    expect((await within(dlg).findByRole('alert')).textContent).toBe('This would leave less than 0 units on hand');
  });

  it('history: every movement in plain words, with orders, imports and who did it', async () => {
    const u = userEvent.setup();
    setup({ extra: { 'GET /admin/inventory/1/movements': () => [200, {
      variant: {}, meta: { page: 1, limit: 50, total: 3, totalPages: 1 },
      data: [
        { id: '3', createdAt: '2026-10-03T10:00:00Z', reason: 'RECOUNT', onHandDelta: -9, reservedDelta: 0, onHandAfter: 1, reservedAfter: 3, orderNumber: null, importId: 12, note: null, actor: 'Sanju' },
        { id: '2', createdAt: '2026-10-03T09:30:00Z', reason: 'RESERVE', onHandDelta: 0, reservedDelta: 3, onHandAfter: 10, reservedAfter: 3, orderNumber: 'AQ1001', importId: null, note: null, actor: null },
        { id: '1', createdAt: '2026-10-03T09:00:00Z', reason: 'IMPORT_INITIAL', onHandDelta: 10, reservedDelta: 0, onHandAfter: 10, reservedAfter: 0, orderNumber: null, importId: 11, note: null, actor: 'Asha' },
      ],
    }] } });
    await within(await table()).findByText('RES-21-300G');
    await u.click(within(rowOf('RES-21-300G')).getByRole('button', { name: 'Stock history of RES-21-300G' }));
    const drawer = await screen.findByRole('dialog', { name: 'Stock history: RES-21-300G' });
    const t = within(drawer).getByRole('table', { name: 'Stock movements' });
    await within(t).findByText(/^Count/);
    expect(within(t).getByText(/order AQ1001/)).toBeTruthy();
    expect(within(t).getByRole('link', { name: 'import 12' }).getAttribute('href')).toBe('/imports/12');
    expect(within(t).getByText(/^Imported \(uncounted\)/)).toBeTruthy();
    expect(within(t).getByText(/^Reserved by an order/)).toBeTruthy();
    expect(within(t).getByText('-9')).toBeTruthy();
  });
});
