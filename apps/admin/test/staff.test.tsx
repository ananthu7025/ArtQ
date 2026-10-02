// Staff & Permissions page and the public password pages, against a fake API.
import { permissionsFor } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import type { StaffRow } from '../src/pages/StaffPage';
import { expectFieldError, expectFieldValid } from './field';
import { err, fakeServer, type Handler } from './fake-server';

type Role = 'STAFF' | 'ADMIN' | 'SUPER_ADMIN';
const me = (role: Role) => ({ id: 7, name: 'Asha', email: 'asha@artq.in', role });
const row = (o: Partial<StaffRow> & { id: number }): StaffRow => ({
  name: `Person ${o.id}`, email: `p${o.id}@artq.in`, role: 'STAFF', status: 'ACTIVE', passwordSet: true, lastLoginAt: null,
  createdAt: '2026-10-01T10:00:00Z', activeSessions: 0, ...o,
});
const page = (rows: StaffRow[]) => [200, { data: rows, meta: { page: 1, limit: 50, total: rows.length, totalPages: 1 } }] as [number, unknown];

function setup(o: { path: string; session: Role | null; extra?: Record<string, Handler> }) {
  const s = fakeServer({
    'POST /admin/auth/refresh': () => (o.session ? [200, { accessToken: 'tok', user: me(o.session) }] : err(401, 'SESSION_INVALID')),
    'GET /admin/me': () => (o.session ? [200, { user: me(o.session), permissions: permissionsFor(o.session) }] : err(401, 'SESSION_INVALID')),
    ...o.extra,
  });
  window.history.replaceState({}, '', o.path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
async function noAxeViolations(node: Element) {
  const res = await axe.run(node, { rules: { 'color-contrast': { enabled: false } } });
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

const ROWS = [
  row({ id: 7, name: 'Asha', email: 'asha@artq.in', role: 'SUPER_ADMIN', activeSessions: 1, lastLoginAt: '2026-10-02T09:00:00Z' }),
  row({ id: 8, name: 'Sanju', role: 'STAFF', activeSessions: 2 }),
  row({ id: 9, name: 'Ravi', role: 'ADMIN', status: 'BLOCKED' }),
  row({ id: 10, name: 'Meera', passwordSet: false }),
];

describe('Staff & Permissions page', () => {
  it('lists staff with distinct states; your own row has no Manage button; passes axe', async () => {
    const { container } = setup({ path: '/staff', session: 'SUPER_ADMIN', extra: { 'GET /admin/staff': () => page(ROWS) } });
    const table = await screen.findByRole('table', { name: 'Staff members' });
    await within(table).findByText('Sanju');
    const rowOf = (name: string) => within(table).getByText(name).closest('tr')!;
    expect(within(rowOf('Asha')).getByText('(you)')).toBeTruthy();
    expect(within(rowOf('Asha')).queryByRole('button')).toBeNull();
    expect(within(rowOf('Ravi')).getByText('Blocked')).toBeTruthy();
    expect(within(rowOf('Meera')).getByText('Invite pending')).toBeTruthy();
    expect(within(rowOf('Sanju')).getByText('Active')).toBeTruthy();
    expect(within(rowOf('Sanju')).getByText('Never')).toBeTruthy();
    expect(within(rowOf('Sanju')).getByRole('button', { name: 'Manage Sanju' })).toBeTruthy();
    await noAxeViolations(container);
  });

  it('filters go into the request', async () => {
    const u = userEvent.setup();
    const { server } = setup({ path: '/staff', session: 'SUPER_ADMIN', extra: { 'GET /admin/staff': () => page(ROWS) } });
    await screen.findByText('Sanju');
    await u.selectOptions(screen.getByLabelText('Role'), 'ADMIN');
    await u.selectOptions(screen.getByLabelText('Status'), 'BLOCKED');
    await u.type(screen.getByLabelText('Search name or email'), 'ravi{Enter}');
    await waitFor(() => {
      const q = server.calls.filter((c) => c.path === '/admin/staff').at(-1)!.query;
      expect([q.get('role'), q.get('status'), q.get('q')]).toEqual(['ADMIN', 'BLOCKED', 'ravi']);
    });
  });

  it('ADMIN does not see the module and gets "No access" on the URL', async () => {
    setup({ path: '/staff', session: 'ADMIN' });
    expect(await screen.findByText(/No access/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Staff & Permissions' })).toBeNull();
  });
});

describe('Add staff', () => {
  it('validates, explains the role, asks for the password (step-up), then sends the invite', async () => {
    const u = userEvent.setup();
    let stepped = false;
    const { server } = setup({
      path: '/staff', session: 'SUPER_ADMIN', extra: {
        'GET /admin/staff': () => page(ROWS),
        'POST /admin/auth/step-up': () => { stepped = true; return [200, { stepUpUntil: 'x' }]; },
        'POST /admin/staff': (c) => (stepped ? [201, row({ id: 11, ...(c.body as object) })] : err(401, 'STEP_UP_REQUIRED')),
      },
    });
    await screen.findByText('Sanju');
    await u.click(screen.getByRole('button', { name: 'Add staff' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add staff' });
    await u.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await within(dialog).findByText('Enter a name');
    expectFieldError('Name', 'Enter a name', within(dialog));
    expectFieldError('Email', 'Enter your email address', within(dialog));
    expectFieldValid('Role', within(dialog));
    expect(within(dialog).getByText(/Cannot change prices/)).toBeTruthy();
    await u.selectOptions(within(dialog).getByLabelText('Role'), 'ADMIN');
    expect(within(dialog).getByText(/products, prices, refunds/)).toBeTruthy();
    await u.type(within(dialog).getByLabelText('Name'), 'Devika');
    await u.type(within(dialog).getByLabelText('Email'), 'devika@artq.in');
    await u.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await u.type(await screen.findByLabelText('Password'), 'my-password');
    await u.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Invite sent to devika@artq.in')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add staff' })).toBeNull());
    expect(server.calls.filter((c) => c.method === 'POST' && c.path === '/admin/staff').at(-1)!.body).toEqual({ name: 'Devika', email: 'devika@artq.in', role: 'ADMIN' });
  });

  it('limits match the API exactly: 120-character name and 160-character email pass, one more fails', async () => {
    const u = userEvent.setup();
    const { server } = setup({ path: '/staff', session: 'SUPER_ADMIN', extra: { 'GET /admin/staff': () => page(ROWS), 'POST /admin/staff': (c) => [201, row({ id: 12, ...(c.body as object) })] } });
    await screen.findByText('Sanju');
    await u.click(screen.getByRole('button', { name: 'Add staff' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add staff' });
    const email160 = `${'a'.repeat(160 - '@artq.in'.length)}@artq.in`;
    await u.type(within(dialog).getByLabelText('Name'), 'n'.repeat(121));
    await u.type(within(dialog).getByLabelText('Email'), `b${email160}`);
    await u.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await within(dialog).findByText('Use at most 120 characters');
    expectFieldError('Name', 'Use at most 120 characters', within(dialog));
    expectFieldError('Email', 'Use at most 160 characters', within(dialog));
    await u.clear(within(dialog).getByLabelText('Name'));
    await u.type(within(dialog).getByLabelText('Name'), 'n'.repeat(120));
    await u.clear(within(dialog).getByLabelText('Email'));
    await u.type(within(dialog).getByLabelText('Email'), email160);
    await u.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(server.calls.some((c) => c.method === 'POST' && c.path === '/admin/staff')).toBe(true));
  });

  it('a server VALIDATION_ERROR lands on its field (red border + message), not in the form alert', async () => {
    const u = userEvent.setup();
    setup({ path: '/staff', session: 'SUPER_ADMIN', extra: {
      'GET /admin/staff': () => page(ROWS),
      'POST /admin/staff': () => err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'email', message: 'Enter a valid email address' }]),
    } });
    await screen.findByText('Sanju');
    await u.click(screen.getByRole('button', { name: 'Add staff' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add staff' });
    await u.type(within(dialog).getByLabelText('Name'), 'Devika');
    await u.type(within(dialog).getByLabelText('Email'), 'devika@artq.in');
    await u.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expectFieldError('Email', 'Enter a valid email address', within(dialog)));
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('a server refusal is shown inside the dialog, which stays open', async () => {
    const u = userEvent.setup();
    setup({ path: '/staff', session: 'SUPER_ADMIN', extra: { 'GET /admin/staff': () => page(ROWS), 'POST /admin/staff': () => err(409, 'STAFF_EXISTS', 'This person is already on the staff list') } });
    await screen.findByText('Sanju');
    await u.click(screen.getByRole('button', { name: 'Add staff' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add staff' });
    await u.type(within(dialog).getByLabelText('Name'), 'Sanju');
    await u.type(within(dialog).getByLabelText('Email'), 'p8@artq.in');
    await u.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('This person is already on the staff list');
    expect(screen.getByRole('dialog', { name: 'Add staff' })).toBeTruthy();
  });
});

describe('Manage staff', () => {
  const manage = async (name: string, extra: Record<string, Handler>) => {
    const u = userEvent.setup();
    const s = setup({ path: '/staff', session: 'SUPER_ADMIN', extra: { 'GET /admin/staff': () => page(ROWS), ...extra } });
    await u.click(await screen.findByRole('button', { name: `Manage ${name}` }));
    return { u, ...s, dialog: await screen.findByRole('dialog', { name: `Manage ${name}` }) };
  };

  it('role change asks for confirmation, then PATCHes the role', async () => {
    const { u, dialog, server } = await manage('Sanju', { 'PATCH /admin/staff/8': (c) => [200, row({ id: 8, ...(c.body as object) })] });
    const save = within(dialog).getByRole('button', { name: 'Save role' });
    expect((save as HTMLButtonElement).disabled).toBe(true);    // nothing changed yet
    await u.selectOptions(within(dialog).getByLabelText('Role'), 'ADMIN');
    await u.click(save);
    const confirm = await screen.findByRole('dialog', { name: 'Make Sanju Admin?' });
    await u.click(within(confirm).getByRole('button', { name: 'Change role' }));
    expect(await screen.findByText("Sanju's role was updated. They need to log in again.")).toBeTruthy();
    expect(server.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ role: 'ADMIN' });
  });

  it('block: cancel sends nothing; confirm POSTs /block', async () => {
    const { u, server } = await manage('Sanju', { 'POST /admin/staff/8/block': () => [200, row({ id: 8, status: 'BLOCKED' })] });
    await u.click(screen.getByRole('button', { name: 'Block' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Block Sanju?' })).getByRole('button', { name: 'Cancel' }));
    expect(server.calls.some((c) => c.path.endsWith('/block'))).toBe(false);
    await u.click(await screen.findByRole('button', { name: 'Block' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Block Sanju?' })).getByRole('button', { name: 'Block' }));
    expect(await screen.findByText('Sanju is blocked and was logged out everywhere.')).toBeTruthy();
  });

  it('log out everywhere shows the session count; resend invite for someone without a password', async () => {
    const { u, server } = await manage('Sanju', { 'POST /admin/staff/8/revoke-sessions': () => [200, row({ id: 8 })] });
    await u.click(screen.getByRole('button', { name: 'Log out everywhere (2 active)' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Log Sanju out everywhere?' })).getByRole('button', { name: 'Log out everywhere' }));
    await screen.findByText('Sanju was logged out on every device.');
    expect(server.calls.some((c) => c.path === '/admin/staff/8/revoke-sessions')).toBe(true);
  });

  it('a person without a password gets "Resend the invite"; no sessions disables log-out', async () => {
    const { u, dialog, server } = await manage('Meera', { 'POST /admin/staff/10/send-password-link': () => [200, row({ id: 10 })] });
    expect((within(dialog).getByRole('button', { name: 'Log out everywhere' }) as HTMLButtonElement).disabled).toBe(true);
    await u.click(within(dialog).getByRole('button', { name: 'Resend the invite' }));
    await screen.findByText('A password link was emailed to p10@artq.in.');
    expect(server.calls.some((c) => c.path === '/admin/staff/10/send-password-link')).toBe(true);
  });

  it('a blocked person offers Unblock instead of Block; remove access PATCHes role CUSTOMER', async () => {
    const { u, dialog, server } = await manage('Ravi', { 'POST /admin/staff/9/unblock': () => [200, row({ id: 9 })], 'PATCH /admin/staff/9': () => [204, undefined] });
    expect(within(dialog).queryByRole('button', { name: 'Block' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Unblock' })).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Remove admin access' }));
    await u.click(within(await screen.findByRole('dialog', { name: "Remove Ravi's admin access?" })).getByRole('button', { name: 'Remove access' }));
    await screen.findByText('Ravi no longer has admin access.');
    expect(server.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ role: 'CUSTOMER' });
  });

  it('a refusal (last Super Admin) is shown as an error toast', async () => {
    const { u } = await manage('Sanju', { 'POST /admin/staff/8/block': () => err(409, 'LAST_SUPER_ADMIN', 'This is the only active Super Admin. Make someone else Super Admin first.') });
    await u.click(screen.getByRole('button', { name: 'Block' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Block Sanju?' })).getByRole('button', { name: 'Block' }));
    expect(await screen.findByText(/only active Super Admin/)).toBeTruthy();
  });

  it('the manage dialog passes axe', async () => {
    const { dialog } = await manage('Sanju', {});
    await noAxeViolations(dialog);
  });
});

describe('password pages (no session needed)', () => {
  it('login links to "Forgot password"; the request always reports "Check your email"', async () => {
    const u = userEvent.setup();
    const { server } = setup({ path: '/login', session: null, extra: { 'POST /admin/auth/password/forgot': () => [200, { ok: true }] } });
    await u.click(await screen.findByRole('link', { name: 'Forgot your password?' }));
    await u.click(await screen.findByRole('button', { name: 'Send link' }));
    expectFieldError('Email', 'Enter your email address');
    await u.type(screen.getByLabelText('Email'), 'sanju@artq.in');
    await u.click(screen.getByRole('button', { name: 'Send link' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeTruthy();
    expect(server.calls.find((c) => c.path === '/admin/auth/password/forgot')!.body).toEqual({ email: 'sanju@artq.in' });
  });

  it('reset without a token explains the link is incomplete', async () => {
    setup({ path: '/reset-password', session: null });
    expect(await screen.findByRole('heading', { name: 'Link incomplete' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Get a new link' })).toBeTruthy();
  });

  it('reset: short and mismatched passwords, an expired link, then success', async () => {
    const u = userEvent.setup();
    let attempts = 0;
    const { server } = setup({
      path: '/reset-password?token=tok123', session: null,
      extra: { 'POST /admin/auth/password/reset': () => (++attempts === 1 ? err(422, 'TOKEN_INVALID') : [200, { ok: true }]) },
    });
    const pw = await screen.findByLabelText('New password');
    const again = screen.getByLabelText('Repeat the password');
    const submit = screen.getByRole('button', { name: 'Set password' });
    await u.type(pw, 'short');
    await u.type(again, 'different');
    await u.click(submit);
    expectFieldError('New password', 'Use at least 12 characters');
    expectFieldError('Repeat the password', 'The passwords do not match');
    await u.clear(pw); await u.type(pw, 'a-long-password');
    await u.clear(again); await u.type(again, 'a-long-password');
    await u.click(submit);
    expect((await screen.findByRole('alert')).textContent).toContain('This link has expired or was already used.');
    await u.click(submit);
    expect(await screen.findByRole('heading', { name: 'Password set' })).toBeTruthy();
    expect(server.calls.filter((c) => c.path === '/admin/auth/password/reset').map((c) => c.body)).toEqual([
      { token: 'tok123', password: 'a-long-password' }, { token: 'tok123', password: 'a-long-password' },
    ]);
  });
});
