// Task 6.4 in the admin against a fake API: redirects (empty submit shows the field messages, a shop address and a
// target on another site refused by the shared rules, the server's "already redirects" on its field, 302 sent as a
// number, edit, delete confirmed) and search listings (at least one field, the title and description at the boundary,
// a server refusal on its field, hide from search). STAFF has no CMS.
import { permissionsFor, type RedirectRow, type Role, type SeoOverrideRow } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

const redirect = (o: Partial<RedirectRow> = {}): RedirectRow => ({ id: 4, fromPath: '/collections/resin', toPath: '/type/resins', statusCode: 301, ...o });
const listing = (o: Partial<SeoOverrideRow> = {}): SeoOverrideRow => ({ id: 7, path: '/new-arrivals', metaTitle: 'Fresh resin supplies', metaDescription: null, canonical: null, noindex: false, ...o });
const page = <T,>(data: T[]) => [200, { data, meta: { page: 1, limit: 50, total: data.length, totalPages: 1 } }] as [number, unknown];

function setup(path: string, extra: Record<string, Handler> = {}, role: Role = 'ADMIN') {
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 1, name: 'Anu', email: 'anu@artq.in', role } }],
    'GET /admin/me': () => [200, { user: { id: 1, name: 'Anu', email: 'anu@artq.in', role }, permissions: permissionsFor(role) }],
    'GET /admin/seo/redirects': () => page([redirect()]),
    'GET /admin/seo/overrides': () => page([listing(), listing({ id: 8, path: '/secret', metaTitle: null, noindex: true })]),
    ...extra,
  });
  window.history.replaceState({}, '', path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const sent = (s: ReturnType<typeof setup>['server'], method: string, path: string) => s.calls.filter((c) => c.method === method && c.path === path);

describe('redirects', () => {
  it('list and search; empty submit; shared rules on the fields; the server’s refusal on its field; saved as a number; accessible', async () => {
    const u = userEvent.setup();
    let reply: [number, unknown] = err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'toPath', message: 'That address already redirects to /faqs. Point straight there.' }]);
    const { server, container } = setup('/cms?tab=redirects', { 'POST /admin/seo/redirects': () => reply });
    expect(await screen.findByText('/collections/resin')).toBeTruthy();
    expect(screen.getByText('Permanent (301)')).toBeTruthy();
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
    await u.type(screen.getByLabelText('Search addresses'), 'resin');
    await u.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(sent(server, 'GET', '/admin/seo/redirects').at(-1)!.query.get('q')).toBe('resin'));

    await u.click(screen.getByRole('button', { name: 'Add redirect' }));
    const d = within(await screen.findByRole('dialog', { name: 'Add redirect' }));
    await u.click(d.getByRole('button', { name: 'Save redirect' }));
    await waitFor(() => expectFieldError('Old address', 'Enter an address', d));
    expectFieldError('Goes to', 'Enter where it should go', d);
    await u.type(d.getByLabelText('Old address'), '/product/old');
    await u.type(d.getByLabelText('Goes to'), '//evil.example');
    await u.click(d.getByRole('button', { name: 'Save redirect' }));
    await waitFor(() => expectFieldError('Old address', 'This address is served by the shop (renamed products and categories already redirect by themselves)', d));
    expectFieldError('Goes to', 'Use an address on this site starting with /, like /shop or /shop?type=resins', d);
    expect(sent(server, 'POST', '/admin/seo/redirects')).toEqual([]);
    await u.clear(d.getByLabelText('Old address'));
    await u.type(d.getByLabelText('Old address'), '/Old-Sale/');
    await u.clear(d.getByLabelText('Goes to'));
    await u.type(d.getByLabelText('Goes to'), '/first');
    await u.selectOptions(d.getByLabelText('Kind'), '302');
    await u.click(d.getByRole('button', { name: 'Save redirect' }));
    await waitFor(() => expectFieldError('Goes to', 'That address already redirects to /faqs. Point straight there.', d));
    reply = [201, redirect({ id: 5, fromPath: '/old-sale', toPath: '/faqs', statusCode: 302 })];
    await u.clear(d.getByLabelText('Goes to'));
    await u.type(d.getByLabelText('Goes to'), '/faqs');
    await u.click(d.getByRole('button', { name: 'Save redirect' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add redirect' })).toBeNull());
    expect(sent(server, 'POST', '/admin/seo/redirects').at(-1)!.body).toEqual({ fromPath: '/old-sale', toPath: '/faqs', statusCode: 302 });
  });

  it('edit keeps the row’s values; delete is confirmed', async () => {
    const u = userEvent.setup();
    const { server } = setup('/cms?tab=redirects', {
      'PUT /admin/seo/redirects/4': (c) => [200, { ...redirect(), ...(c.body as object) }],
      'DELETE /admin/seo/redirects/4': () => [204, undefined],
    });
    await u.click(await screen.findByRole('button', { name: 'Edit redirect /collections/resin' }));
    const d = within(await screen.findByRole('dialog', { name: 'Edit redirect' }));
    expect((d.getByLabelText('Goes to') as HTMLInputElement).value).toBe('/type/resins');
    await u.clear(d.getByLabelText('Goes to'));
    await u.type(d.getByLabelText('Goes to'), '/shop?type=resins');
    await u.click(d.getByRole('button', { name: 'Save redirect' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/seo/redirects/4')[0]!.body).toEqual({ fromPath: '/collections/resin', toPath: '/shop?type=resins', statusCode: 301 }));
    await u.click(await screen.findByRole('button', { name: 'Delete redirect /collections/resin' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Delete this redirect?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sent(server, 'DELETE', '/admin/seo/redirects/4')).toHaveLength(1));
  });
});

describe('search listings', () => {
  it('state shown; at least one field; title and description at the boundary; server refusal on its field; hide from search saved', async () => {
    const u = userEvent.setup();
    let reply: [number, unknown] = err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'path', message: 'This address already has an override; edit that one' }]);
    const { server } = setup('/cms?tab=seo', { 'POST /admin/seo/overrides': () => reply });
    expect(await screen.findByText('Fresh resin supplies')).toBeTruthy();
    expect(screen.getByText('Hidden from search')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Add search listing' }));
    const d = within(await screen.findByRole('dialog', { name: 'Add search listing' }));
    await u.type(d.getByLabelText('Address'), '/shop');
    await u.click(d.getByRole('button', { name: 'Save listing' }));
    await waitFor(() => expectFieldError('Title (optional)', 'Set at least one of title, description, canonical or “hide from search”', d));
    await u.click(d.getByLabelText('Title (optional)'));
    await u.paste('t'.repeat(161));
    await u.click(d.getByLabelText('Description (optional)'));
    await u.paste('d'.repeat(321));
    await u.click(d.getByRole('button', { name: 'Save listing' }));
    await waitFor(() => expectFieldError('Title (optional)', 'Use at most 160 characters', d));
    expectFieldError('Description (optional)', 'Use at most 320 characters', d);
    expect(d.getByText('321 / 320. Google shows about 155 characters.')).toBeTruthy();
    await u.type(d.getByLabelText('Title (optional)'), '{Backspace}');
    await u.type(d.getByLabelText('Description (optional)'), '{Backspace}');
    await u.click(d.getByLabelText('Hide this page from search engines'));
    await u.click(d.getByRole('button', { name: 'Save listing' }));
    await waitFor(() => expectFieldError('Address', 'This address already has an override; edit that one', d));
    reply = [201, listing({ id: 9, path: '/shop' })];
    await u.clear(d.getByLabelText('Address'));
    await u.type(d.getByLabelText('Address'), '/Shop/');
    await u.click(d.getByRole('button', { name: 'Save listing' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add search listing' })).toBeNull());
    expect(sent(server, 'POST', '/admin/seo/overrides').at(-1)!.body).toEqual({ path: '/shop', metaTitle: 't'.repeat(160), metaDescription: 'd'.repeat(320), canonical: null, noindex: true });
  });

  it('a canonical on another protocol is refused under the field', async () => {
    const u = userEvent.setup();
    setup('/cms?tab=seo');
    await u.click(await screen.findByRole('button', { name: 'Add search listing' }));
    const d = within(await screen.findByRole('dialog', { name: 'Add search listing' }));
    await u.type(d.getByLabelText('Address'), '/shop');
    await u.type(d.getByLabelText('Canonical address (optional)'), 'http://artq.in/shop');
    await u.click(d.getByRole('button', { name: 'Save listing' }));
    await waitFor(() => expectFieldError('Canonical address (optional)', 'Use an address starting with / or https://', d));
  });

  it('STAFF has no CMS', async () => {
    setup('/cms?tab=seo', {}, 'STAFF');
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeTruthy();
  });
});
