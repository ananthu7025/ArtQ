// Task 5.7: the customer's order pages against a fake API. The account list and order; cancelling (the shared rule on
// the reason, one Idempotency-Key); reporting a problem (the shared rules on reason, quantities and photos, a photo
// uploaded and processed before sending, a server refusal on the item's quantity); the guest page from the tracking
// link: read-only until the email code, a wrong code on the code field, then the actions.
import type { CustomerOrderSummary, CustomerOrderView } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../components/account/AuthProvider';
import { SiteToaster } from '../components/layout/SiteToaster';
import { AccountOrderView, OrdersListView, TrackOrderView } from '../components/orders/views';
import { ShopProvider } from '../components/shop/ShopProvider';
import { API_URL } from '../lib/api';
import { HINT_KEY, StoreSession } from '../lib/session';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (status: number, code: string, message: string, details?: unknown) => json({ error: { code, message, details } }, status);
const view = (o: Partial<CustomerOrderView> = {}): CustomerOrderView => ({
  access: 'owner', orderNumber: 'AQ10234', createdAt: '2026-10-05T06:30:00Z', placedAt: '2026-10-05T06:31:00Z', displayStatus: 'Delivered',
  status: 'CONFIRMED', paymentStatus: 'PAID', fulfilmentStatus: 'DELIVERED', returnStatus: 'NONE', paymentMethod: 'RAZORPAY',
  items: [{ id: 1, name: 'Epoxy Resin', label: '500 ml', imageUrl: null, unitPrice: 50_000, quantity: 2, lineTotal: 100_000, returnableQty: 2 }],
  totals: { subtotal: 100_000, couponDiscount: 0, couponCode: null, shipping: 7000, codFee: 0, total: 107_000, refunded: 0 },
  shippingAddress: { name: 'Hema Rajan', lines: ['12 Rose Villa', 'Kochi, Kerala 682011'], phone: '+919847012345' },
  shipment: { courierName: 'DTDC', awbNumber: 'D123', trackingUrl: null, shippedAt: '2026-10-06T06:00:00Z', deliveredAt: '2026-10-07T06:00:00Z' },
  timeline: [{ label: 'Order placed', at: '2026-10-05T06:31:00Z' }, { label: 'Delivered', at: '2026-10-07T06:00:00Z' }], refunds: [], returns: [],
  returnDeadline: '2026-10-09T06:00:00Z', actions: { canCancel: false, canRetryPayment: false, canRequestReturn: true, canDownloadInvoice: true }, ...o,
});

type Route = (body: unknown, headers: Record<string, string>) => Response | Promise<Response>;
let routes: Record<string, Route>;
let calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[];
beforeEach(() => {
  calls = [];
  routes = { 'GET /cart': () => json({ items: [], coupon: null, warnings: [], totals: { itemCount: 0 } }) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.startsWith(API_URL) ? url.slice(API_URL.length) : url;
    const method = init.method ?? 'GET';
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body ? '[file]' : undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, body, headers });
    const r = routes[`${method} ${path}`];
    if (!r) throw new TypeError('Failed to fetch');
    return r(body, headers);
  }));
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const app = (children: ReactNode) => render(<AuthProvider session={new StoreSession({ channel: null, locks: null })}><ShopProvider>{children}<SiteToaster /></ShopProvider></AuthProvider>);
const signedIn = () => {
  window.localStorage.setItem(HINT_KEY, '1');
  routes['POST /auth/refresh'] = () => json({ accessToken: 'TOKEN', user: { id: 7, name: 'Hema', email: 'hema@example.com', emailVerified: true, phone: null, marketingOptIn: false } });
  routes['GET /me/wishlist'] = () => json({ productIds: [], data: [] });
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const expectFieldError = (el: HTMLElement, message: string) => {
  expect(el.getAttribute('aria-invalid')).toBe('true');
  expect((el.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent)).toContain(message);
};
const axeClean = async (el: Element) => expect((await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => x.id)).toEqual([]);

describe('account orders', () => {
  it('lists orders with status and total, each linking to its page', async () => {
    signedIn();
    const row: CustomerOrderSummary = { orderNumber: 'AQ10234', createdAt: '2026-10-05T06:30:00Z', displayStatus: 'Shipped', total: 107_000, itemCount: 2, firstItem: { name: 'Epoxy Resin', imageUrl: null } };
    routes['GET /me/orders?page=1'] = () => json({ data: [row], meta: { page: 1, totalPages: 1, total: 1 } });
    const { container } = app(<OrdersListView />);
    const link = await screen.findByRole('link', { name: /AQ10234 · Shipped/ });
    expect(link.getAttribute('href')).toBe('/account/orders/AQ10234');
    expect(link.textContent).toContain('₹1,070');
    expect(sent('GET', '/me/orders?page=1')[0]!.headers.Authorization).toBe('Bearer TOKEN');
    await axeClean(container);
  });

  it('cancel: the shared limit on the reason; one key; the order reloads', async () => {
    signedIn();
    let current = view({ displayStatus: 'Order placed', fulfilmentStatus: 'UNFULFILLED', shipment: null, actions: { canCancel: true, canRetryPayment: false, canRequestReturn: false, canDownloadInvoice: false }, returnDeadline: null });
    routes['GET /me/orders/AQ10234'] = () => json(current);
    routes['POST /me/orders/AQ10234/cancel'] = () => { current = view({ displayStatus: 'Cancelled', actions: { canCancel: false, canRetryPayment: false, canRequestReturn: false, canDownloadInvoice: false } }); return json({ status: 'CANCELLED' }); };
    const u = userEvent.setup();
    app(<AccountOrderView orderNumber="AQ10234" />);
    await u.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const panel = within(screen.getByRole('region', { name: 'Cancel this order?' }));
    expect(panel.getByText('₹1,070 is refunded to your original payment method in 5–7 working days.')).toBeTruthy();
    await u.type(panel.getByLabelText('Why are you cancelling? (optional)'), 'x'.repeat(301));
    await u.click(panel.getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expectFieldError(panel.getByLabelText('Why are you cancelling? (optional)'), 'Use at most 300 characters'));
    await u.clear(panel.getByLabelText('Why are you cancelling? (optional)'));
    await u.type(panel.getByLabelText('Why are you cancelling? (optional)'), 'Ordered twice');
    await u.click(panel.getByRole('button', { name: 'Cancel order' }));
    expect(await screen.findByLabelText('Order status')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Order status').textContent).toBe('Cancelled'));
    expect(sent('POST', '/me/orders/AQ10234/cancel')[0]!.body).toEqual({ reason: 'Ordered twice' });
    expect(sent('POST', '/me/orders/AQ10234/cancel')[0]!.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('report a problem: rules on each field; a photo is uploaded and processed first; a server refusal lands on the item', async () => {
    signedIn();
    routes['GET /me/orders/AQ10234'] = () => json(view());
    routes['POST /me/orders/AQ10234/uploads/presign'] = () => json({ media: { id: 55 }, upload: { url: 'https://storage.test/priv/a.jpg', headers: { 'Content-Type': 'image/jpeg' } } }, 201);
    routes['PUT https://storage.test/priv/a.jpg'] = () => new Response(null, { status: 200 });
    routes['POST /me/orders/AQ10234/uploads/55/complete'] = () => json({ media: { id: 55, status: 'UPLOADED' } });
    routes['GET /me/orders/AQ10234/uploads/55'] = () => json({ media: { id: 55, status: 'READY', failureReason: null } });
    let reply = apiError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'items.0.quantity', message: 'That’s more than is left to return for this item (other return requests count too)' }]);
    routes['POST /me/orders/AQ10234/returns'] = () => reply;
    const u = userEvent.setup();
    const { container } = app(<AccountOrderView orderNumber="AQ10234" />);
    await u.click(await screen.findByRole('button', { name: 'Report a problem' }));
    const panel = within(screen.getByRole('region', { name: 'Report a problem' }));
    await axeClean(container);
    await u.click(panel.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expectFieldError(panel.getByLabelText('What went wrong?'), 'Choose what went wrong'));
    expect(panel.getByText('Choose at least one item')).toBeTruthy();
    await u.selectOptions(panel.getByLabelText('What went wrong?'), 'DAMAGED');
    await u.type(panel.getByLabelText('Epoxy Resin (500 ml), up to 2'), '1.5');
    await u.click(panel.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expectFieldError(panel.getByLabelText('Epoxy Resin (500 ml), up to 2'), 'Enter how many'));
    await u.clear(panel.getByLabelText('Epoxy Resin (500 ml), up to 2'));
    await u.type(panel.getByLabelText('Epoxy Resin (500 ml), up to 2'), '1');
    await u.click(panel.getByRole('button', { name: 'Send report' }));                     // the photo rule is checked once the rest is valid
    await waitFor(() => expectFieldError(panel.getByLabelText(/^Photos/), 'Add at least one photo of the problem'));
    expect(sent('POST', '/me/orders/AQ10234/returns')).toHaveLength(0);
    await u.upload(panel.getByLabelText(/^Photos/), new File(['x'], 'a.jpg', { type: 'image/jpeg' }));
    expect(await panel.findByText('a.jpg: ready')).toBeTruthy();
    await u.click(panel.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expectFieldError(panel.getByLabelText('Epoxy Resin (500 ml), up to 2'), 'That’s more than is left to return for this item (other return requests count too)'));
    reply = json({ id: 9, status: 'REQUESTED' }, 201);
    await u.click(panel.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText('We’ve received your report and will email you within 2 working days.')).toBeTruthy();
    expect(sent('POST', '/me/orders/AQ10234/returns').at(-1)!.body).toEqual({ reason: 'DAMAGED', description: null, items: [{ orderItemId: 1, quantity: 1 }], mediaIds: [55] });
  });
});

describe('guest order page', () => {
  it('tracking link: read-only with the verify panel; a wrong code on the code field; then the actions', async () => {
    routes['GET /orders/AQ10234'] = () => apiError(404, 'NOT_FOUND', 'Order not found');
    routes['GET /orders/track/AQ10234?token=tok_abcdefghijklmnopqrstuvwxyz'] = () => json(view({ access: 'tracking', shippingAddress: { name: 'Hema', lines: ['Kochi, Kerala 682011'], phone: '+********2345' }, actions: { canCancel: false, canRetryPayment: false, canRequestReturn: false, canDownloadInvoice: false } }));
    routes['POST /orders/AQ10234/access/request'] = () => json({ sent: true, resendAfter: 30 });
    let verify = apiError(422, 'OTP_INVALID', 'The code is not valid');
    routes['POST /orders/AQ10234/access/verify'] = () => verify;
    const u = userEvent.setup();
    const { container } = app(<TrackOrderView orderNumber="AQ10234" token="tok_abcdefghijklmnopqrstuvwxyz" />);
    expect(await screen.findByRole('heading', { name: 'Manage this order' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Report a problem' })).toBeNull();
    expect(screen.getByText('Phone +********2345')).toBeTruthy();
    await axeClean(container);
    await u.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expectFieldError(screen.getByLabelText('Email used for the order'), 'Enter your email address'));
    await u.type(screen.getByLabelText('Email used for the order'), 'hema@example.com');
    await u.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(/If hema@example.com is the email on this order, a 6-digit code is on its way/)).toBeTruthy();
    await u.type(screen.getByLabelText('6-digit code'), '12345');
    await u.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expectFieldError(screen.getByLabelText('6-digit code'), 'Enter the 6-digit code'));
    await u.type(screen.getByLabelText('6-digit code'), '6');
    await u.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expectFieldError(screen.getByLabelText('6-digit code'), 'The code is not valid'));
    verify = json(view({ access: 'guest' }));
    await u.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('button', { name: 'Report a problem' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Manage this order' })).toBeNull();
    expect(sent('POST', '/orders/AQ10234/access/verify').at(-1)!.body).toEqual({ email: 'hema@example.com', code: '123456' });
  });

  it('already verified within the hour → straight to the full order; a bad link explains itself', async () => {
    routes['GET /orders/AQ10234'] = () => json(view({ access: 'guest' }));
    app(<TrackOrderView orderNumber="AQ10234" token={null} />);
    expect(await screen.findByRole('button', { name: 'Invoice' })).toBeTruthy();
  });

  it('an invalid or expired link', async () => {
    routes['GET /orders/AQ1'] = () => apiError(404, 'NOT_FOUND', 'Order not found');
    routes['GET /orders/track/AQ1?token=bad_token_bad_token_bad'] = () => apiError(404, 'NOT_FOUND', 'This tracking link is not valid or has expired.');
    app(<TrackOrderView orderNumber="AQ1" token="bad_token_bad_token_bad" />);
    expect(await screen.findByRole('heading', { name: 'We couldn’t open this order' })).toBeTruthy();
  });
});
