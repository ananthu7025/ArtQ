// Task 4.2: sign-in pages, the account area, addresses and the wishlist against a fake API. Each form follows the
// validation rule: the shared Zod schema, empty submit → messages under the fields, limits at the boundary, and a
// server field error lands on its field.
import type { AddressView, CartView, ProductCard } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountView } from '../components/account/AccountView';
import { AddressesView } from '../components/account/AddressesView';
import { AuthProvider } from '../components/account/AuthProvider';
import { LoginView } from '../components/account/LoginView';
import { ResetView, SetPasswordView } from '../components/account/PasswordViews';
import { SignupView, VerifyView } from '../components/account/SignupView';
import { WishlistView } from '../components/account/WishlistView';
import { Header } from '../components/layout/Header';
import { SiteToaster } from '../components/layout/SiteToaster';
import { ShopProvider } from '../components/shop/ShopProvider';
import { API_URL } from '../lib/api';
import { HINT_KEY, StoreSession, type Customer } from '../lib/session';
import { nav } from './setup';

const USER: Customer = { id: 7, name: 'Asha Menon', email: 'asha@example.com', emailVerified: true, phone: null, marketingOptIn: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (status: number, code: string, message: string, details?: unknown) => json({ error: { code, message, details } }, status);
const fieldError = (path: string, message: string) => apiError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path, message }]);
const cartView = (itemCount: number) => ({ items: [], coupon: null, warnings: [], totals: { itemCount } }) as unknown as CartView;
const card = (id: number): ProductCard => ({
  id, slug: `p-${id}`, name: `Product ${id}`, image: null, hoverImage: null, fromPrice: 19_000, maxPrice: 19_000, mrp: null, discountPercent: null, inStock: true, isNew: false, isTrending: false,
  variantCount: 2, defaultVariantId: null, type: { slug: 'pigments', name: 'Pigments' },
});
const address = (o: Partial<AddressView> & { id: number }): AddressView => ({
  label: 'HOME', fullName: 'Asha Menon', phone: '+919847012345', line1: '12 MG Road', line2: null, landmark: null, city: 'Kochi', state: { id: 32, name: 'Kerala' }, pincode: '682011', isDefault: false, ...o,
});

type Route = (body: unknown, auth: string | null) => Response | Promise<Response>;
let routes: Record<string, Route>;
let calls: { method: string; path: string; body: unknown; auth: string | null }[];
beforeEach(() => {
  calls = [];
  routes = { 'GET /cart': () => json(cartView(0)), 'GET /states': () => json({ data: [{ id: 29, name: 'Karnataka', code: 'KA' }, { id: 32, name: 'Kerala', code: 'KL' }] }) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace(API_URL, '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization ?? null;
    calls.push({ method, path, body, auth });
    const r = routes[`${method} ${path}`];
    if (!r) throw new TypeError('Failed to fetch');
    return r(body, auth);
  }));
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const session = () => new StoreSession({ channel: null, locks: null });
const app = (children: ReactNode, s = session()) => render(<AuthProvider session={s}><ShopProvider><Header navigation={{ types: [] }} />{children}<SiteToaster /></ShopProvider></AuthProvider>);
/** This browser has a session: the page load refreshes and gets USER. */
const signedIn = (user = USER) => {
  window.localStorage.setItem(HINT_KEY, '1');
  routes['POST /auth/refresh'] = () => json({ accessToken: 'TOKEN', user });
  routes['GET /me/wishlist'] = () => json({ productIds: [], data: [] });
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const field = (name: string | RegExp) => screen.getByLabelText(name, { selector: 'input,select' });
/** The validation rule's look: aria-invalid on the input and its message right under it, linked by aria-describedby. */
const expectFieldError = (name: string | RegExp, message: string) => {
  const el = field(name);
  expect(el.getAttribute('aria-invalid')).toBe('true');
  const ids = (el.getAttribute('aria-describedby') ?? '').split(' ');
  expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain(message);
};
const axeClean = async (el: Element) => expect((await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

describe('login', () => {
  it('empty submit → field messages and no request; passes axe', async () => {
    const u = userEvent.setup();
    const { container } = app(<LoginView next="/account" />);
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expectFieldError('Email', 'Enter your email address'));
    expectFieldError('Password', 'Enter your password');
    expect(sent('POST', '/auth/login')).toEqual([]);
    await axeClean(container);
  });

  it('wrong password → one message (never says which part); locked → minutes and the code option; unverified → the code page', async () => {
    const u = userEvent.setup();
    app(<LoginView next="/account" />);
    await u.type(field('Email'), 'asha@example.com');
    await u.type(field('Password'), 'nope');
    routes['POST /auth/login'] = () => apiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Email or password is incorrect');
    routes['POST /auth/login'] = () => apiError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts.', { retryAfterSeconds: 840 });
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Too many wrong passwords. Try again in 14 minutes, or log in with an email code.'));
    routes['POST /auth/login'] = () => apiError(403, 'NOT_VERIFIED', 'Verify your email to continue');
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    await u.click(await screen.findByRole('link', { name: 'Enter your code' }));
    expect(window.sessionStorage.getItem('aq_verify_email')).toBe('asha@example.com');
  });

  it('success: the session starts, the header greets by first name, and the page moves on to `next`', async () => {
    const u = userEvent.setup();
    routes['POST /auth/login'] = () => json({ accessToken: 'TOKEN', user: USER });
    routes['GET /me/wishlist'] = () => json({ productIds: [], data: [] });
    app(<LoginView next="/account/addresses" />);
    await u.type(field('Email'), ' asha@example.com ');
    await u.type(field('Password'), 'correct-horse-9');
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/account/addresses'));
    expect(sent('POST', '/auth/login')[0]!.body).toEqual({ email: 'asha@example.com', password: 'correct-horse-9' });
    expect(window.localStorage.getItem(HINT_KEY)).toBe('1');
    expect(screen.getAllByRole('link', { name: 'Your account' }).map((a) => a.textContent)).toContain('Asha');
    await waitFor(() => expect(sent('GET', '/cart').at(-1)!.auth).toBe('Bearer TOKEN'));   // the cart reloads as the account's
  });

  it('email code: tabs work with arrow keys; the code goes to the email; a wrong code lands on the code field; resend waits 30 s', async () => {
    const u = userEvent.setup();
    routes['POST /auth/otp/request'] = () => json({ sent: true, resendAfter: 30 });
    app(<LoginView next="/account" />);
    screen.getByRole('tab', { name: 'Password' }).focus();
    await u.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Email code' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Email code' }));
    await u.click(screen.getByRole('button', { name: 'Email me a code' }));
    await waitFor(() => expectFieldError('Email', 'Enter your email address'));
    await u.type(field('Email'), 'asha@example.com');
    await u.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(await screen.findByText(/Send again in 30 s/)).toBeTruthy();
    expect(sent('POST', '/auth/otp/request')[0]!.body).toEqual({ email: 'asha@example.com', purpose: 'LOGIN' });
    await u.type(field('6-digit code'), '12345');
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expectFieldError('6-digit code', 'Enter the 6-digit code'));
    routes['POST /auth/otp/verify'] = () => apiError(422, 'OTP_INVALID', 'The code is not valid');
    await u.type(field('6-digit code'), '6');
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expectFieldError('6-digit code', 'The code is not valid'));
    routes['POST /auth/otp/verify'] = () => json({ accessToken: 'TOKEN', user: USER });
    routes['GET /me/wishlist'] = () => json({ productIds: [], data: [] });
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/account'));
    expect(sent('POST', '/auth/otp/verify').at(-1)!.body).toEqual({ email: 'asha@example.com', purpose: 'LOGIN', code: '123456' });
  });

  it('a signed-in visitor goes straight on', async () => {
    signedIn();
    app(<LoginView next="/wishlist" />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/wishlist'));
  });
});

describe('signup', () => {
  it('empty submit → messages under name, email and password; passes axe', async () => {
    const u = userEvent.setup();
    const { container } = app(<SignupView next="/account" />);
    await u.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expectFieldError('Full name', 'Enter a name'));
    expectFieldError('Email', 'Enter your email address');
    expectFieldError('Password', 'Use at least 8 characters');
    expect(field('Mobile number (optional)').getAttribute('aria-invalid')).toBeNull();
    expect(sent('POST', '/auth/signup')).toEqual([]);
    await axeClean(container);
  });

  it('limits as on the server: name 120 ok / 121 not; password 8 with a letter and a number; phone 10–14 digits', async () => {
    const u = userEvent.setup();
    app(<SignupView next="/account" />);
    await u.click(field('Full name')); await u.paste('x'.repeat(121));
    await u.type(field('Email'), 'a@b.in');
    await u.type(field('Password'), 'abcdefgh');
    await u.type(field('Mobile number (optional)'), '12345');
    await u.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expectFieldError('Full name', 'Use at most 120 characters'));
    expectFieldError('Password', 'Use at least one letter and one number');
    expectFieldError('Mobile number (optional)', 'Enter a phone number of 10 to 14 digits');
    await u.type(field('Full name'), '{Backspace}');
    await u.type(field('Password'), '{Backspace}1');
    await u.clear(field('Mobile number (optional)'));
    routes['POST /auth/signup'] = () => json({ otpSentTo: 'a***@b.in' }, 201);
    await u.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/signup/verify'));
    expect(sent('POST', '/auth/signup')[0]!.body).toEqual({ name: 'x'.repeat(120), email: 'a@b.in', password: 'abcdefg1', marketingOptIn: false });   // empty phone not sent
    expect(window.sessionStorage.getItem('aq_verify_email')).toBe('a@b.in');
  });

  it('a server field error lands on its field; `next` is carried to the code page', async () => {
    const u = userEvent.setup();
    routes['POST /auth/signup'] = () => fieldError('email', 'Use a different email address');
    app(<SignupView next="/wishlist" />);
    await u.type(field('Full name'), 'Asha');
    await u.type(field('Email'), 'a@b.in');
    await u.type(field('Password'), 'abcdefg1');
    await u.type(field('Mobile number (optional)'), '+91 98470-12345');
    await u.click(screen.getByLabelText(/Email me about new arrivals/));
    await u.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expectFieldError('Email', 'Use a different email address'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sent('POST', '/auth/signup')[0]!.body).toMatchObject({ phone: '+919847012345', marketingOptIn: true });
    routes['POST /auth/signup'] = () => json({ otpSentTo: 'a***@b.in' }, 201);
    await u.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/signup/verify?next=%2Fwishlist'));
  });

  it('verify: the email from the signup page is used (not asked again); a wrong code lands on the code field; success signs in', async () => {
    const u = userEvent.setup();
    window.sessionStorage.setItem('aq_verify_email', 'a@b.in');
    routes['POST /auth/signup/verify'] = () => apiError(422, 'OTP_EXPIRED', 'The code has expired. Request a new one.');
    app(<VerifyView next="/account" />);
    expect(screen.getByLabelText('Email', { selector: 'input' }).closest('[hidden]')).not.toBeNull();
    await u.type(field('6-digit code'), '123456');
    await u.click(screen.getByRole('button', { name: 'Confirm email' }));
    await waitFor(() => expectFieldError('6-digit code', 'The code has expired. Request a new one.'));
    routes['POST /auth/signup/verify'] = () => json({ accessToken: 'TOKEN', user: USER });
    routes['GET /me/wishlist'] = () => json({ productIds: [], data: [] });
    await u.click(screen.getByRole('button', { name: 'Confirm email' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/account'));
    expect(sent('POST', '/auth/signup/verify').at(-1)!.body).toEqual({ email: 'a@b.in', code: '123456' });
    expect(window.sessionStorage.getItem('aq_verify_email')).toBeNull();
  });

  it('verify in a new tab asks for the email', async () => {
    const u = userEvent.setup();
    app(<VerifyView next="/account" />);
    expect(field('Email').closest('[hidden]')).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Confirm email' }));
    await waitFor(() => expectFieldError('Email', 'Enter your email address'));
  });
});

describe('reset and set password', () => {
  it('reset: both passwords must match (client-only field) on top of the shared rule; an expired link says so; success → log in', async () => {
    const u = userEvent.setup();
    app(<ResetView token={'t'.repeat(43)} />);
    await u.click(screen.getByRole('button', { name: 'Save password' }));
    await waitFor(() => expectFieldError('New password', 'Use at least 8 characters'));
    await u.type(field('New password'), 'abcdefg1');
    await u.type(field('Type it again'), 'abcdefg2');
    await u.click(screen.getByRole('button', { name: 'Save password' }));
    await waitFor(() => expectFieldError('Type it again', 'The passwords do not match'));
    routes['POST /auth/password/reset'] = () => apiError(422, 'TOKEN_INVALID', 'This link is invalid or has expired');
    await u.type(field('Type it again'), '{Backspace}1');
    await u.click(screen.getByRole('button', { name: 'Save password' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/expired or was already used/);
    routes['POST /auth/password/reset'] = () => json({ ok: true });
    await u.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByRole('link', { name: 'Log in' })).toBeTruthy();
    expect(sent('POST', '/auth/password/reset').at(-1)!.body).toEqual({ token: 't'.repeat(43), password: 'abcdefg1' });
  });

  it('a link without its token explains instead of showing the form', () => {
    app(<ResetView token={null} />);
    expect(screen.getByRole('alert').textContent).toMatch(/This link is incomplete/);
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('set password: creates the account and signs in; an existing account is told to log in', async () => {
    const u = userEvent.setup();
    routes['POST /auth/set-password'] = () => apiError(409, 'ACCOUNT_EXISTS', 'exists');
    app(<SetPasswordView token={'t'.repeat(43)} />);
    await u.type(field('New password'), 'abcdefg1');
    await u.type(field('Type it again'), 'abcdefg1');
    await u.click(screen.getByRole('button', { name: 'Create account' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already has an account/);
    routes['POST /auth/set-password'] = () => json({ accessToken: 'TOKEN', user: USER });
    routes['GET /me/wishlist'] = () => json({ productIds: [], data: [] });
    await u.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/account'));
  });
});

describe('account page', () => {
  it('not signed in → the login page, coming back after', async () => {
    app(<AccountView />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login?next=%2Faccount'));
  });

  it('Log out goes home (not to the login page); a logout in another tab sends this page to login', async () => {
    const u = userEvent.setup();
    signedIn();
    routes['POST /auth/logout'] = () => json({ ok: true });
    app(<AccountView />);
    await u.click(await screen.findByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/'));
    expect(nav.replace).not.toHaveBeenCalled();
    expect(await screen.findByText('You’re logged out.')).toBeTruthy();
    expect(sent('POST', '/auth/logout')).toHaveLength(1);

    // Another tab: the same page open; the session ends elsewhere (broadcast → this tab's session clears itself).
    signedIn();
    const s = session();
    app(<AccountView />, s);
    await screen.findAllByRole('button', { name: 'Log out' });
    s.ended();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login?next=%2Faccount'));
  });

  it('profile: saves name, phone and choice; the header follows; validation as on the server; passes axe', async () => {
    const u = userEvent.setup();
    signedIn();
    routes['PATCH /me'] = (b) => json({ user: { ...USER, ...(b as object) } });
    const { container } = app(<AccountView />);
    const name = await screen.findByLabelText('Full name');
    await u.clear(name);
    await u.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expectFieldError('Full name', 'Enter a name'));
    await u.type(name, 'Devika Nair');
    await u.type(field('Mobile number (for delivery updates)'), '98470 12345');
    await u.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(sent('PATCH', '/me')).toHaveLength(1));
    expect(sent('PATCH', '/me')[0]).toMatchObject({ body: { name: 'Devika Nair', phone: '9847012345', marketingOptIn: false }, auth: 'Bearer TOKEN' });
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Your account' }).map((a) => a.textContent)).toContain('Devika'));
    await axeClean(container);
  });

  it('password: a wrong current password lands on its field; success logs out everywhere and goes to login', async () => {
    const u = userEvent.setup();
    signedIn();
    routes['POST /me/password'] = () => fieldError('currentPassword', 'This password is not correct');
    app(<AccountView />);
    await u.type(await screen.findByLabelText('Current password'), 'wrong-pass-1');
    await u.type(field('New password'), 'new-pass-12');
    await u.type(field('Type it again'), 'new-pass-12');
    await u.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expectFieldError('Current password', 'This password is not correct'));
    routes['POST /me/password'] = () => json({ ok: true });
    await u.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/login'));
    expect(window.localStorage.getItem(HINT_KEY)).toBeNull();
    expect(await screen.findByText('Password changed. Please log in with your new password.')).toBeTruthy();
  });

  it('email change: password and new address → a code to the new address → changed, logged out', async () => {
    const u = userEvent.setup();
    signedIn();
    app(<AccountView />);
    await u.click(await screen.findByRole('button', { name: 'Change email' }));
    await u.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expectFieldError('New email', 'Enter your email address'));
    expectFieldError('Your password', 'Enter your password');
    routes['POST /me/email/change'] = () => fieldError('newEmail', 'Another account uses this email address');
    await u.type(field('New email'), 'new@example.com');
    await u.type(field('Your password'), 'correct-horse-9');
    await u.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expectFieldError('New email', 'Another account uses this email address'));
    routes['POST /me/email/change'] = () => json({ otpSentTo: 'n***@example.com' });
    await u.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('n***@example.com')).toBeTruthy();
    routes['POST /me/email/verify'] = () => json({ ok: true, email: 'new@example.com' });
    await u.type(field('6-digit code'), '123456');
    await u.click(screen.getByRole('button', { name: 'Change email' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/login'));
  });

  it('delete: the box must be ticked (shared rule), then the account goes and the visitor is logged out', async () => {
    const u = userEvent.setup();
    signedIn();
    routes['DELETE /me'] = () => json({ ok: true });
    app(<AccountView />);
    await u.click(await screen.findByRole('button', { name: 'Delete my account' }));
    const panel = screen.getByRole('region', { name: 'Delete account' });
    await u.type(within(panel).getByLabelText('Your password', { selector: 'input' }), 'correct-horse-9');
    await u.click(within(panel).getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expectFieldError('I understand my account will be deleted', 'Tick the box to confirm'));
    expect(sent('DELETE', '/me')).toEqual([]);
    await u.click(field('I understand my account will be deleted'));
    await u.click(within(panel).getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/'));
    expect(sent('DELETE', '/me')[0]!.body).toEqual({ password: 'correct-horse-9', confirm: true });
  });
});

describe('addresses', () => {
  it('lists them with the default first; empty add form → messages; the pincode fills state and city; a server mismatch lands on the pincode', async () => {
    const u = userEvent.setup();
    signedIn();
    routes['GET /me/addresses'] = () => json({ data: [address({ id: 1, isDefault: true })] });
    routes['GET /pincodes/560001'] = () => json({ pincode: '560001', district: 'BENGALURU URBAN', state: { id: 29, name: 'Karnataka' } });
    routes['POST /me/addresses'] = () => fieldError('pincode', 'This pincode is in Karnataka');
    const { container } = app(<AddressesView />);
    expect(await screen.findByText('Default')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Add an address' }));
    await u.click(screen.getByRole('button', { name: 'Add address' }));
    await waitFor(() => expectFieldError('Full name', 'Enter the name for delivery'));
    expectFieldError('Pincode', 'Enter a 6-digit pincode');
    expectFieldError('State', 'Choose a state');
    expectFieldError('City / town', 'Enter the city or town');
    expectFieldError('House / flat, building and street', 'Enter the house / building and street');
    await u.type(field('Pincode'), '560001');
    await waitFor(() => expect((field('State') as HTMLSelectElement).value).toBe('29'));
    expect((field('City / town') as HTMLInputElement).value).toBe('Bengaluru Urban');
    expect(screen.getByText('Bengaluru Urban, Karnataka')).toBeTruthy();
    await u.type(field('Full name'), 'Asha');
    await u.type(field('Mobile number'), '9847012345');
    await u.type(field('House / flat, building and street'), '1 MG Road');
    await u.click(screen.getByRole('button', { name: 'Add address' }));
    await waitFor(() => expectFieldError('Pincode', 'This pincode is in Karnataka'));
    expect(sent('POST', '/me/addresses')[0]!.body).toEqual({ label: 'HOME', fullName: 'Asha', phone: '9847012345', line1: '1 MG Road', line2: null, landmark: null, city: 'Bengaluru Urban', stateId: 29, pincode: '560001', isDefault: false });
    await axeClean(container);
  });

  it('limits as on the server: full name 120 passes, 121 fails', async () => {
    const u = userEvent.setup();
    signedIn();
    routes['GET /me/addresses'] = () => json({ data: [] });
    routes['POST /me/addresses'] = (b) => json(address({ id: 2, ...(b as object) }), 201);
    app(<AddressesView />);
    await u.click(await screen.findByRole('button', { name: 'Add an address' }));
    expect((field('Use as my default address') as HTMLInputElement).checked).toBe(true);   // the first one
    await u.click(field('Full name')); await u.paste('x'.repeat(121));
    await u.type(field('Mobile number'), '9847012345');
    await u.type(field('Pincode'), '682011');
    await u.selectOptions(field('State'), '32');
    await u.type(field('House / flat, building and street'), '1 MG Road');
    await u.type(field('City / town'), 'Kochi');
    await u.click(screen.getByRole('button', { name: 'Add address' }));
    await waitFor(() => expectFieldError('Full name', 'Use at most 120 characters'));
    await u.type(field('Full name'), '{Backspace}');
    await u.click(screen.getByRole('button', { name: 'Add address' }));
    await waitFor(() => expect(sent('POST', '/me/addresses')).toHaveLength(1));
    expect(await screen.findByText('Address added')).toBeTruthy();
  });

  it('at 10 addresses adding is off and says why; remove asks first; make default', async () => {
    const u = userEvent.setup();
    signedIn();
    const ten = Array.from({ length: 10 }, (_, i) => address({ id: i + 1, isDefault: i === 0, fullName: `Person ${i + 1}` }));
    routes['GET /me/addresses'] = () => json({ data: ten });
    routes['DELETE /me/addresses/3'] = () => json({ data: ten.filter((a) => a.id !== 3) });
    routes['POST /me/addresses/2/default'] = () => json({ data: ten });
    app(<AddressesView />);
    await screen.findByText('Person 10');
    expect((screen.getByRole('button', { name: 'Add an address' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/You can save up to 10 addresses/)).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Remove Home address of Person 3' }));
    expect(sent('DELETE', '/me/addresses/3')).toEqual([]);
    await u.click(within(screen.getByRole('group', { name: 'Remove the Home address of Person 3?' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Person 3')).toBeNull());
    await u.click(screen.getByRole('button', { name: 'Make Home address of Person 2 the default' }));
    await waitFor(() => expect(sent('POST', '/me/addresses/2/default')).toHaveLength(1));
  });
});

describe('wishlist', () => {
  it('guest: the browser list, fetched in batches of 24; products no longer for sale are hidden; the log-in hint shows', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => i + 1);
    window.localStorage.setItem('aq_wishlist', JSON.stringify(ids));
    routes[`GET /products/by-ids?ids=${ids.slice(0, 24).join(',')}`] = () => json({ data: ids.slice(0, 24).filter((i) => i !== 5).map(card) });
    routes[`GET /products/by-ids?ids=${ids.slice(24).join(',')}`] = () => json({ data: ids.slice(24).map(card) });
    app(<WishlistView />);
    await screen.findByText('Product 30');
    expect(screen.queryByText('Product 5')).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(29);
    expect(screen.getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe('/login?next=/wishlist');
  });

  it('empty → the empty state', async () => {
    app(<WishlistView />);
    expect(await screen.findByText('Your wishlist is empty')).toBeTruthy();
  });

  it('at sign-in the browser list joins the account (then is cleared); ♡ saves to the account; a failed save is undone', async () => {
    const u = userEvent.setup();
    window.localStorage.setItem('aq_wishlist', JSON.stringify([3]));
    signedIn();
    let saved = [9, 3];
    routes['POST /me/wishlist/merge'] = () => json({ productIds: saved, data: [] });
    routes['GET /products/by-ids?ids=9,3'] = () => json({ data: [card(9), card(3)] });
    routes['POST /me/wishlist/toggle'] = () => { saved = [3]; return json({ saved: false, productIds: saved, data: [] }); };
    app(<WishlistView />);
    await screen.findByText('Product 9');
    expect(sent('POST', '/me/wishlist/merge')[0]).toMatchObject({ body: { productIds: [3] }, auth: 'Bearer TOKEN' });
    expect(window.localStorage.getItem('aq_wishlist')).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Remove Product 9 from wishlist' }));
    await waitFor(() => expect(screen.queryByText('Product 9')).toBeNull());
    expect(sent('POST', '/me/wishlist/toggle')[0]!.body).toEqual({ productId: 9 });
    routes['POST /me/wishlist/toggle'] = () => apiError(503, 'UNAVAILABLE', 'Try again shortly.');
    await u.click(screen.getByRole('button', { name: 'Remove Product 3 from wishlist' }));
    expect(await screen.findByText(/Your wishlist was not updated/)).toBeTruthy();
    expect(screen.getByText('Product 3')).toBeTruthy();
  });
});
