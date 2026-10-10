// The real App against a fake API: login, guards, shell + drawer, DataTable states, dialogs, accessibility.
import { permissionsFor } from '@artq/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AdminApi, type Page } from '../src/api/client';
import { App } from '../src/App';
import { DataTable, useTableParams } from '../src/components/DataTable';
import { StepUpDialog, VersionConflictDialog } from '../src/components/dialogs';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

type Role = 'STAFF' | 'ADMIN' | 'SUPER_ADMIN';
const user = (role: Role) => ({ id: 7, name: 'Asha', email: 'asha@artq.in', role });

function setup(o: { path: string; session: Role | null; extra?: Record<string, Handler> }) {
  let role = o.session;
  const s = fakeServer({
    'POST /admin/auth/refresh': () => (role ? [200, { accessToken: 'tok', user: user(role) }] : err(401, 'SESSION_INVALID')),
    'GET /admin/me': () => (role ? [200, { user: user(role), permissions: permissionsFor(role) }] : err(401, 'SESSION_INVALID')),
    'POST /admin/auth/login': (c) => {
      const b = c.body as { email: string; password: string };
      if (b.password === 'locked') return err(423, 'ACCOUNT_LOCKED', 'locked', { retryAfterSeconds: 840 });
      if (b.password !== 'right-password') return err(401, 'INVALID_CREDENTIALS');
      role = 'ADMIN';
      return [200, { accessToken: 'tok', user: user('ADMIN') }];
    },
    'POST /admin/auth/logout': () => { role = null; return [200, { ok: true }]; },
    ...o.extra,
  });
  window.history.replaceState({}, '', o.path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  const r = render(<App api={api} />);
  return { ...r, server: s, api };
}

async function noAxeViolations(node: Element) {
  const res = await axe.run(node, { rules: { 'color-contrast': { enabled: false } } });   // jsdom has no layout; contrast is checked in Playwright
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

describe('login and session', () => {
  it('without a session every route redirects to the login page, then back after logging in', async () => {
    const u = userEvent.setup();
    setup({ path: '/audit-logs', session: null });
    expect(await screen.findByRole('heading', { name: 'ArtQ Admin' })).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    await screen.findByText('Enter your email address');
    expectFieldError('Email', 'Enter your email address');
    expectFieldError('Password', 'Enter your password');
    await u.type(screen.getByLabelText('Email'), 'not-an-email');
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expectFieldError('Email', 'Enter a valid email address'));
    await u.clear(screen.getByLabelText('Email'));
    await u.type(screen.getByLabelText('Email'), 'asha@artq.in');
    await u.type(screen.getByLabelText('Password'), 'wrong');
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Email or password is incorrect.');
    await u.clear(screen.getByLabelText('Password'));
    await u.type(screen.getByLabelText('Password'), 'locked');
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Too many failed attempts. Try again in 14 minutes.');
    await u.clear(screen.getByLabelText('Password'));
    await u.type(screen.getByLabelText('Password'), 'right-password');
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    // ADMIN has no audit:read → the remembered destination shows "No access" inside the shell
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeTruthy();
    expect(window.location.pathname).toBe('/audit-logs');
  });

  it('the login page passes axe', async () => {
    const { container } = setup({ path: '/login', session: null });
    await screen.findByRole('button', { name: 'Log in' });
    await noAxeViolations(container);
  });

  it('logging out returns to the login page', async () => {
    const u = userEvent.setup();
    setup({ path: '/dashboard', session: 'ADMIN' });
    await u.click(await screen.findByRole('button', { name: /Log out/ }));
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy();
  });
});

describe('shell and navigation', () => {
  it('shows only the modules the role may use; the current item is marked aria-current=page', async () => {
    setup({ path: '/customers', session: 'STAFF' });
    const sidebar = await screen.findByTestId('sidebar');
    const links = within(sidebar).getAllByRole('link').map((a) => a.textContent);
    expect(links).toEqual(['Dashboard', 'Orders', 'Customers', 'Products', 'Restock Requests', 'Inventory', 'Returns & Refunds', 'Imports']);
    expect(within(sidebar).getByRole('link', { name: 'Customers' }).getAttribute('aria-current')).toBe('page');
    expect(within(sidebar).getByRole('link', { name: 'Orders' }).getAttribute('aria-current')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Customers' })).toBeTruthy();
  });

  it('a module not built yet shows its placeholder', async () => {
    setup({ path: '/cms', session: 'ADMIN' });
    expect(await screen.findByText(/delivered by task 6.1/)).toBeTruthy();
  });

  it('a module the role cannot use shows "No access" even when typed into the address bar', async () => {
    setup({ path: '/settings', session: 'ADMIN' });
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeTruthy();
  });

  it('unknown paths show "Page not found" inside the shell', async () => {
    setup({ path: '/nope', session: 'ADMIN' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });

  it('the drawer opens from the menu button, traps focus, closes on Esc and returns focus; navigating closes it', async () => {
    const u = userEvent.setup();
    setup({ path: '/dashboard', session: 'SUPER_ADMIN' });
    const menu = await screen.findByRole('button', { name: 'Open navigation' });
    await u.click(menu);
    const drawer = await screen.findByTestId('drawer');
    expect(within(drawer).getAllByRole('link')).toHaveLength(20);
    expect(drawer.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 30; i++) await u.tab();
    expect(drawer.contains(document.activeElement)).toBe(true);                // focus never leaves the drawer
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('drawer')).toBeNull());
    expect(document.activeElement).toBe(menu);
    await u.click(menu);
    await u.click(within(await screen.findByTestId('drawer')).getByRole('link', { name: 'Audit Logs' }));
    await waitFor(() => expect(screen.queryByTestId('drawer')).toBeNull());
    expect(window.location.pathname).toBe('/audit-logs');
  });

  it('the shell passes axe', async () => {
    const { container } = setup({ path: '/dashboard', session: 'SUPER_ADMIN' });
    await screen.findByText(/Welcome, Asha/);
    await noAxeViolations(container);
  });
});

const auditRows = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ id: String(from + i), createdAt: '2026-10-02T10:00:00Z', action: 'admin.login', entity: 'user', entityId: '7', actor: { id: 7, email: 'asha@artq.in', name: 'Asha' }, ip: '127.0.0.1' }));

describe('DataTable on the Audit Logs page', () => {
  it('skeleton rows while loading, then rows; sorting and paging go into the URL and the request', async () => {
    const u = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { server } = setup({ path: '/audit-logs', session: 'SUPER_ADMIN', extra: {
      'GET /admin/audit-logs': async (c) => { await gate; const page = Number(c.query.get('page')); return [200, { data: auditRows(page === 2 ? 3 : 25, page === 2 ? 26 : 1), meta: { page, limit: 25, total: 28, totalPages: 2 } }]; },
    } });
    expect((await screen.findAllByTestId('skeleton-row')).length).toBe(8);
    await act(async () => { release(); });
    expect(await screen.findByText('Page 1 of 2 · 28 total')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(26);                         // header + 25
    expect(screen.getByRole('button', { name: '‹ Previous' }).hasAttribute('disabled')).toBe(true);
    await u.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(await screen.findByText('Page 2 of 2 · 28 total')).toBeTruthy();
    expect(window.location.search).toBe('?page=2');
    expect(screen.getByRole('button', { name: 'Next ›' }).hasAttribute('disabled')).toBe(true);
    const when = screen.getByRole('columnheader', { name: /When/ });
    expect(when.getAttribute('aria-sort')).toBe('descending');
    await u.click(within(when).getByRole('button'));
    await waitFor(() => expect(window.location.search).toBe('?sort=createdAt'));    // sorting resets to page 1
    expect(when.getAttribute('aria-sort')).toBe('ascending');
    expect(server.calls.at(-1)!.query.get('sort')).toBe('createdAt');
  });

  it('empty results with a filter offer "Clear filters"', async () => {
    const u = userEvent.setup();
    setup({ path: '/audit-logs?entity=media', session: 'SUPER_ADMIN', extra: {
      'GET /admin/audit-logs': (c) => [200, { data: c.query.get('entity') ? [] : auditRows(2), meta: { page: 1, limit: 25, total: c.query.get('entity') ? 0 : 2, totalPages: 1 } }],
    } });
    expect(await screen.findByText('No audit entries match.')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Page 1 of 1 · 2 total')).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  it('a failed load shows "Couldn\'t load" with Retry, which recovers', async () => {
    const u = userEvent.setup();
    let fail = true;
    setup({ path: '/audit-logs', session: 'SUPER_ADMIN', extra: {
      'GET /admin/audit-logs': () => (fail ? err(500, 'INTERNAL', 'Something went wrong') : [200, { data: auditRows(1), meta: { page: 1, limit: 25, total: 1, totalPages: 1 } }]),
    } });
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
    expect(alert.textContent).toContain('Couldn’t load'.replace('’', "'"));
    fail = false;
    await u.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Page 1 of 1 · 1 total')).toBeTruthy();
  });
});

describe('DataTable selection and bulk actions', () => {
  type Row = { id: string; name: string };
  function Harness({ pages }: { pages: Row[][] }) {
    const params = useTableParams({ sort: 'name', filterKeys: [] });
    const data = pages[params.page - 1] ?? [];
    const [done, setDone] = useState<string[]>([]);
    const query = { data: { data, meta: { page: params.page, limit: 2, total: pages.flat().length, totalPages: pages.length } } as Page<Row>, isPending: false, isError: false, error: null, isFetching: false, refetch: () => {} };
    const columns: ColumnDef<Row, unknown>[] = [{ id: 'name', header: 'Name', cell: ({ row }) => row.original.name }];
    return (
      <>
        <DataTable caption="Rows" columns={columns} query={query} params={params} getRowId={(r) => r.id} emptyMessage="None" selectable
          bulkActions={(ids, clear) => <button type="button" onClick={() => { setDone(ids); clear(); }}>Archive</button>} />
        <output data-testid="done">{done.join(',')}</output>
      </>
    );
  }
  it('select-all-on-page, bulk action receives the ids, selection clears on page change', async () => {
    const u = userEvent.setup();
    const router = createMemoryRouter([{ path: '/', element: <Harness pages={[[{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], [{ id: 'c', name: 'C' }]]} /> }]);
    render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
    const all = screen.getByRole('checkbox', { name: 'Select all rows on this page' }) as HTMLInputElement;
    await u.click(screen.getByRole('checkbox', { name: 'Select row a' }));
    expect(all.indeterminate).toBe(true);
    expect(screen.getByText('1 selected')).toBeTruthy();
    await u.click(all);
    expect(screen.getByText('2 selected')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByTestId('done').textContent).toBe('a,b');
    expect(screen.queryByText(/selected/)).toBeNull();
    await u.click(screen.getByRole('checkbox', { name: 'Select row b' }));
    await u.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(await screen.findByText('C')).toBeTruthy();
    expect(screen.queryByText(/selected/)).toBeNull();                              // per-page selection reset
  });
});

describe('useTableParams', () => {
  it('two changes before the next render both stay in the URL (filter, then search)', async () => {
    function Harness() {
      const params = useTableParams({ sort: 'name', filterKeys: ['stock', 'q'] });
      return (
        <>
          <button type="button" onClick={() => { params.setPage(3); params.setFilter('stock', 'out'); params.setFilter('q', 'res'); }}>Both</button>
          <button type="button" onClick={() => { params.setFilter('stock', null); params.setSort('-name'); }}>Clear stock, sort</button>
          <output data-testid="filters">{JSON.stringify(params.filters)} {params.page} {params.sort}</output>
        </>
      );
    }
    const u = userEvent.setup();
    const router = createMemoryRouter([{ path: '/', element: <Harness /> }], { initialEntries: ['/?page=2&keep=1'] });
    render(<RouterProvider router={router} />);
    await u.click(screen.getByRole('button', { name: 'Both' }));
    expect(screen.getByTestId('filters').textContent).toBe('{"stock":"out","q":"res"} 1 name');   // a filter change resets the page
    expect(router.state.location.search).toBe('?keep=1&stock=out&q=res');                        // unrelated params survive
    await u.click(screen.getByRole('button', { name: 'Clear stock, sort' }));
    expect(router.state.location.search).toBe('?keep=1&q=res&sort=-name');
  });
});

describe('dialogs', () => {
  it('version conflict: offers reload or keep editing', async () => {
    const u = userEvent.setup();
    const log: string[] = [];
    render(<VersionConflictDialog open entity="product" onReload={() => log.push('reload')} onKeepEditing={() => log.push('keep')} />);
    expect(screen.getByRole('alertdialog').textContent).toContain('This product was changed by someone else');
    await u.click(screen.getByRole('button', { name: 'Load latest version' }));
    await u.click(screen.getByRole('button', { name: 'Keep editing' }));
    await u.keyboard('{Escape}');
    expect(log).toEqual(['reload', 'keep', 'keep']);
  });

  it('step-up: a 401 STEP_UP_REQUIRED opens the password dialog; a wrong password shows an error; success retries', async () => {
    const u = userEvent.setup();
    let stepped = false;
    const s = fakeServer({
      'POST /admin/auth/step-up': (c) => ((c.body as { password: string }).password === 'pw-ok' ? (stepped = true, [200, { stepUpUntil: 'x' }]) : err(401, 'INVALID_CREDENTIALS')),
      'POST /admin/refunds': () => (stepped ? [201, { refundId: 1 }] : err(401, 'STEP_UP_REQUIRED')),
    });
    const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
    render(<StepUpDialog api={api} />);
    const result = api.request('POST', '/admin/refunds', { body: {} });
    const pw = await screen.findByLabelText('Password');
    await u.type(pw, 'bad');
    await u.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expectFieldError('Password', 'That password is not correct.'));
    await u.clear(pw);
    await u.type(pw, 'pw-ok');
    await u.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(result).resolves.toEqual({ refundId: 1 });
    await waitFor(() => expect(screen.queryByLabelText('Password')).toBeNull());
  });

  it('step-up cancelled: the request fails with STEP_UP_REQUIRED', async () => {
    const u = userEvent.setup();
    const s = fakeServer({ 'POST /admin/refunds': () => err(401, 'STEP_UP_REQUIRED') });
    const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
    render(<StepUpDialog api={api} />);
    const result = api.request('POST', '/admin/refunds', { body: {} }).then(() => null, (e: unknown) => e);   // observe the rejection immediately
    await u.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await result).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });
});
