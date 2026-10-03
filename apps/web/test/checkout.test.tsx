// Task 4.6: the checkout page against a fake API: the shared checkoutInitiateBody rules under each field, pincode
// autofill and the delivery check, COD availability, saved addresses, billing and GST, and every payment outcome
// (COD placed; Razorpay paid/closed/failed; PAYMENT_STARTING repeats with the same key; PROCESSING polls; retry and
// switch to COD; server refusals on their fields).
import type { AddressView, CartView, CheckoutQuote } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../components/account/AuthProvider';
import { CheckoutPage } from '../components/checkout/CheckoutPage';
import type { FlowDeps } from '../components/checkout/useCheckoutFlow';
import { SiteToaster } from '../components/layout/SiteToaster';
import { ShopProvider } from '../components/shop/ShopProvider';
import { API_URL } from '../lib/api';
import type { RazorpayResult } from '../lib/razorpay';
import { HINT_KEY, StoreSession } from '../lib/session';
import { nav } from './setup';

const item = { id: 1, variantId: 101, productId: 11, productSlug: 'epoxy', productName: 'Epoxy Resin', variantLabel: '500 ml', image: null, unitPrice: 49_900, unitMrp: null, quantity: 1, lineTotal: 49_900, maxQuantity: 10, available: true, priceChanged: false };
const cartView = (o: { shipping?: number | null; problem?: CartView['totals']['shipping']['problem']; codFee?: number } = {}): CartView => {
  const ship = o.shipping === undefined ? null : o.shipping;
  return {
    items: [item], coupon: null, warnings: [],
    totals: { itemCount: 1, subtotal: 49_900, mrpTotal: 49_900, mrpDiscount: 0, couponDiscount: 0, shipping: { amount: ship, estimated: ship === null, freeApplied: false, heavySurcharge: 0, pincode: ship === null ? null : '682011', problem: o.problem ?? null },
      codFee: o.codFee ?? 0, total: 49_900 + (ship ?? 0) + (o.codFee ?? 0), savings: 0, freeShippingThreshold: 100_000, freeShippingRemaining: 50_100 },
  };
};
const quote = (o: { method?: 'RAZORPAY' | 'COD'; cod?: boolean; reason?: CheckoutQuote['cod']['reason']; problem?: CartView['totals']['shipping']['problem'] } = {}): CheckoutQuote => ({
  cart: cartView(o.problem ? { problem: o.problem } : { shipping: 5000, codFee: o.method === 'COD' ? 4000 : 0 }), onlineEnabled: true,
  cod: { available: o.cod ?? true, reason: o.cod === false ? (o.reason ?? 'PINCODE_NO_COD') : null, fee: 4000, min: 20_000, max: 500_000 },
  blocking: o.problem ? [o.problem] : [],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (status: number, code: string, message: string, details?: unknown) => json({ error: { code, message, details } }, status);

type Call = { method: string; path: string; body: unknown; headers: Record<string, string> };
let routes: Record<string, (body: unknown) => Response | Promise<Response>>;
let calls: Call[];
beforeEach(() => {
  calls = [];
  routes = {
    'GET /cart': () => json(cartView()),
    'GET /states': () => json({ data: [{ id: 29, name: 'Karnataka', code: 'KA' }, { id: 32, name: 'Kerala', code: 'KL' }] }),
    'GET /pincodes/682011': () => json({ pincode: '682011', district: 'ERNAKULAM', state: { id: 32, name: 'Kerala' } }),
    'POST /checkout/quote': (b) => json(quote({ method: (b as { paymentMethod: 'RAZORPAY' | 'COD' }).paymentMethod })),
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace(API_URL, '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, headers: (init.headers ?? {}) as Record<string, string> });
    const r = routes[`${method} ${path}`];
    if (!r) throw new TypeError('Failed to fetch');
    return r(body);
  }));
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

let keys: number;
const flowDeps = (pay: FlowDeps['pay'] = async () => ({ kind: 'dismissed' }), pollForMs = 60): FlowDeps => { keys = 0; return { pay, newKey: () => `key-${++keys}`, pollMs: 5, pollForMs, inProgressMs: 5 }; };
const page = (deps = flowDeps(), session?: StoreSession) => render(
  session
    ? <AuthProvider session={session}><ShopProvider><CheckoutPage flowDeps={deps} /><SiteToaster /></ShopProvider></AuthProvider>
    : <ShopProvider><CheckoutPage flowDeps={deps} /><SiteToaster /></ShopProvider>,
);
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const field = (label: string | RegExp) => screen.getByLabelText(label, { selector: 'input,select,textarea' });
const expectFieldError = (label: string | RegExp, message: string) => {
  const el = field(label);
  expect(el.getAttribute('aria-invalid')).toBe('true');
  expect((el.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent)).toContain(message);
};
const axeClean = async (el: Element) => expect((await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

/** Fills the guest form with a valid order. */
async function fillGuest(u: ReturnType<typeof userEvent.setup>) {
  await u.type(await screen.findByLabelText('Email'), 'hema@example.com');
  await u.type(screen.getByLabelText('Mobile number'), '98470 12345');
  await u.type(screen.getByLabelText('Full name'), 'Hema R');
  await u.type(screen.getByLabelText('Phone for delivery'), '98470 12345');
  await u.type(screen.getByLabelText('Pincode'), '682011');
  await waitFor(() => expect((field('State') as HTMLSelectElement).value).toBe('32'));
  await u.type(screen.getByLabelText('House / flat, building and street'), '12 Rose Villa');
  await u.click(screen.getByLabelText(/I agree to the/));
  await screen.findByText('We deliver here, with cash on delivery.');
}

describe('checkout form', () => {
  it('empty submit → every message under its field (shared rules); nothing is placed; passes axe', async () => {
    const u = userEvent.setup();
    const { container } = page();
    await u.click(await screen.findByRole('button', { name: /^Place order/ }));
    await waitFor(() => expectFieldError('Mobile number', 'Enter a 10-digit mobile number'));
    expectFieldError('Email', 'Enter your email address');
    expectFieldError('Full name', 'Enter the name for delivery');
    expectFieldError('Pincode', 'Enter a 6-digit pincode');
    expectFieldError('State', 'Choose a state');
    expectFieldError(/I agree to the/, 'Accept the terms to place your order');
    expect(sent('POST', '/checkout/initiate')).toEqual([]);
    await axeClean(container);
  });

  it('pincode → state and city filled, delivery checked; COD adds its fee; a pincode we cannot serve says so', async () => {
    const u = userEvent.setup();
    page();
    await u.type(await screen.findByLabelText('Pincode'), '682011');
    expect(await screen.findByText('Ernakulam, Kerala')).toBeTruthy();
    expect((field('City / town') as HTMLInputElement).value).toBe('Ernakulam');
    expect(await screen.findByText('We deliver here, with cash on delivery.')).toBeTruthy();
    expect(sent('POST', '/checkout/quote').at(-1)!.body).toEqual({ pincode: '682011', paymentMethod: 'RAZORPAY' });
    expect(screen.getByRole('button', { name: 'Place order · ₹549' })).toBeTruthy();
    await u.click(screen.getByLabelText(/^Cash on delivery/));
    expect(await screen.findByRole('button', { name: 'Place order · ₹589' })).toBeTruthy();
    expect(screen.getByText('Cash on delivery fee')).toBeTruthy();
    routes['POST /checkout/quote'] = () => json(quote({ problem: 'PINCODE_NOT_SERVICEABLE', cod: false, reason: 'NO_DESTINATION' }));
    await u.clear(field('Pincode'));
    await u.type(field('Pincode'), '560001');
    expect(await screen.findAllByText('Sorry, we don’t deliver to this pincode yet.')).not.toHaveLength(0);
  });

  it('COD not allowed → the option is off with the reason; a COD choice falls back to paying online', async () => {
    const u = userEvent.setup();
    page();
    await u.type(await screen.findByLabelText('Pincode'), '682011');
    await screen.findByText('We deliver here, with cash on delivery.');
    await u.click(screen.getByLabelText(/^Cash on delivery/));
    routes['POST /checkout/quote'] = () => json(quote({ cod: false, reason: 'ABOVE_MAX' }));
    await u.click(screen.getByLabelText(/I agree to the/));   // any change re-quotes only on address/method; force one:
    await u.clear(field('Pincode')); await u.type(field('Pincode'), '682011');
    expect(await screen.findByText('This order is above the cash on delivery limit. Please pay online.')).toBeTruthy();
    expect((screen.getByLabelText(/^Cash on delivery/) as HTMLInputElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getByLabelText(/^Pay online/) as HTMLInputElement).checked).toBe(true));
  });

  it('billing and GST: a different billing address is required; a GSTIN needs the business name; note 500/501', async () => {
    const u = userEvent.setup();
    page();
    await fillGuest(u);
    await u.click(screen.getByLabelText('Note for us (optional)')); await u.paste('x'.repeat(501));
    expect((field('Note for us (optional)') as HTMLTextAreaElement).value).toHaveLength(500);   // the shared limit, also on the box
    await u.click(screen.getByLabelText('Add a GSTIN for a business invoice (optional)'));
    await u.type(screen.getByLabelText('GSTIN'), '32abcde1234f1z');
    await u.click(screen.getByRole('button', { name: /^Place order/ }));
    await waitFor(() => expectFieldError('GSTIN', 'Enter a 15-character GSTIN, e.g. 32ABCDE1234F1Z5'));
    await u.type(screen.getByLabelText('GSTIN'), '5');
    await u.click(screen.getByRole('button', { name: /^Place order/ }));
    await waitFor(() => expectFieldError('Business name', 'Enter the business name for the GST invoice'));
    await u.click(screen.getByLabelText('Billing address is the same as delivery'));
    await u.type(screen.getByLabelText('Business name'), 'Hema Arts');
    await u.click(screen.getByRole('button', { name: /^Place order/ }));
    expect(screen.getAllByLabelText('Full name')).toHaveLength(2);   // the billing address form appeared, empty
    await waitFor(() => expect(within(screen.getAllByLabelText('Full name')[1]!.parentElement!).getByText('Enter the name for delivery')).toBeTruthy());
    expect(sent('POST', '/checkout/initiate')).toEqual([]);
  });
});

describe('placing and paying', () => {
  it('COD: the body is the shared shape with an Idempotency-Key; placed → the confirmation page', async () => {
    const u = userEvent.setup();
    routes['POST /checkout/initiate'] = () => json({ orderNumber: 'AQ10234', status: 'PLACED', total: 58_900 }, 201);
    page();
    await fillGuest(u);
    await u.click(screen.getByLabelText(/^Cash on delivery/));
    await u.click(screen.getByLabelText(/Email me a link to set a password/));
    await u.click(await screen.findByRole('button', { name: 'Place order · ₹589' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/checkout/success/AQ10234'));
    const call = sent('POST', '/checkout/initiate')[0]!;
    expect(call.headers['Idempotency-Key']).toBe('key-1');
    expect(call.body).toEqual({
      contact: { email: 'hema@example.com', phone: '+919847012345', sendSetPasswordLink: true }, shippingAddressId: null,
      shippingAddress: { fullName: 'Hema R', phone: '9847012345', line1: '12 Rose Villa', line2: null, landmark: null, city: 'Ernakulam', stateId: 32, pincode: '682011', label: 'HOME', save: false },
      billingSameAsShipping: true, billingAddress: null, gstin: null, businessName: null, paymentMethod: 'COD', customerNote: null, expectedTotal: 58_900, acceptTerms: true,
    });
  });

  it('changing the payment method disables Place order until the new quote arrives (never a stale total)', async () => {
    const u = userEvent.setup();
    page();
    await fillGuest(u);
    expect((screen.getByRole('button', { name: 'Place order · ₹549' }) as HTMLButtonElement).disabled).toBe(false);
    await u.click(screen.getByLabelText(/^Cash on delivery/));
    expect((screen.getByRole('button', { name: /^Place order/ }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Place order · ₹589' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('409 REQUEST_IN_PROGRESS (the first request is still running) → the same key again until the answer', async () => {
    const u = userEvent.setup();
    let n = 0;
    routes['POST /checkout/initiate'] = () => (++n < 3 ? apiError(409, 'REQUEST_IN_PROGRESS', 'Still processing') : json({ orderNumber: 'AQ9', status: 'PLACED', total: 58_900 }, 201));
    page();
    await fillGuest(u);
    await u.click(screen.getByLabelText(/^Cash on delivery/));
    await u.click(await screen.findByRole('button', { name: 'Place order · ₹589' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/checkout/success/AQ9'));
    expect(sent('POST', '/checkout/initiate').map((c) => c.headers['Idempotency-Key'])).toEqual(['key-1', 'key-1', 'key-1']);
  });

  it('online: Razorpay paid → verified → placed', async () => {
    const u = userEvent.setup();
    const pay = vi.fn(async (): Promise<RazorpayResult> => ({ kind: 'paid', paymentId: 'pay_1', signature: 'sig' }));
    routes['POST /checkout/initiate'] = () => json({ orderNumber: 'AQ1', status: 'PENDING_PAYMENT', total: 54_900, expiresAt: '2026-10-03T12:30:00Z', razorpay: { keyId: 'rzp_test_x', orderId: 'order_1', amount: 54_900, currency: 'INR', name: 'ArtQ', prefill: {} } }, 201);
    routes['POST /checkout/verify'] = () => json({ status: 'PLACED' });
    page(flowDeps(pay));
    await fillGuest(u);
    await u.click(screen.getByRole('button', { name: 'Place order · ₹549' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/checkout/success/AQ1'));
    expect(pay).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order_1' }), 'AQ1');
    expect(sent('POST', '/checkout/verify')[0]!.body).toEqual({ orderNumber: 'AQ1', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig' });
  });

  it('payment starting (202) → the same key again; closed in Razorpay → "Payment didn’t go through"; Retry and Switch to COD use new keys', async () => {
    const u = userEvent.setup();
    let n = 0;
    routes['POST /checkout/initiate'] = () => (++n === 1 ? json({ orderNumber: 'AQ2', status: 'PAYMENT_STARTING', retryAfter: 0 }, 202)
      : json({ orderNumber: 'AQ2', status: 'PENDING_PAYMENT', total: 54_900, expiresAt: 'x', razorpay: { keyId: 'k', orderId: 'order_2', amount: 54_900, currency: 'INR', name: 'ArtQ', prefill: {} } }, 201));
    routes['POST /checkout/payment-failed'] = () => json({ ok: true });
    routes['POST /orders/AQ2/payment/retry'] = (b) => json((b as { paymentMethod: string }).paymentMethod === 'COD'
      ? { orderNumber: 'AQ2', status: 'PLACED', total: 58_900 }
      : { orderNumber: 'AQ2', status: 'PENDING_PAYMENT', total: 54_900, expiresAt: 'x', razorpay: null, retryPayment: true });
    page(flowDeps(async () => ({ kind: 'failed', paymentId: 'pay_x', reason: 'Your bank declined the payment.' })));
    await fillGuest(u);
    await u.click(screen.getByRole('button', { name: 'Place order · ₹549' }));
    expect(await screen.findByRole('heading', { name: 'Payment didn’t go through' }, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText(/Your bank declined the payment\./)).toBeTruthy();
    expect(sent('POST', '/checkout/initiate').map((c) => c.headers['Idempotency-Key'])).toEqual(['key-1', 'key-1']);
    expect(sent('POST', '/checkout/payment-failed')[0]!.body).toEqual({ orderNumber: 'AQ2', razorpayPaymentId: 'pay_x', error: 'Your bank declined the payment.' });
    await u.click(screen.getByRole('button', { name: 'Retry payment' }));
    expect(await screen.findByText(/The payment couldn’t start\./)).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Switch to cash on delivery (+ ₹40)' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/checkout/success/AQ2'));
    expect(sent('POST', '/orders/AQ2/payment/retry').map((c) => [c.body, c.headers['Idempotency-Key']])).toEqual([[{ paymentMethod: 'RAZORPAY' }, 'key-2'], [{ paymentMethod: 'COD' }, 'key-3']]);
  });

  it('verify says PROCESSING → polls the status until placed; if it takes too long → "we’ll email you"', async () => {
    const u = userEvent.setup();
    routes['POST /checkout/initiate'] = () => json({ orderNumber: 'AQ3', status: 'PENDING_PAYMENT', total: 54_900, expiresAt: 'x', razorpay: { keyId: 'k', orderId: 'o', amount: 1, currency: 'INR', name: 'ArtQ', prefill: {} } }, 201);
    routes['POST /checkout/verify'] = () => json({ status: 'PROCESSING' }, 202);
    let polls = 0;
    routes['GET /checkout/status/AQ3'] = () => json({ status: ++polls < 3 ? 'PENDING_PAYMENT' : 'PLACED', paymentStatus: 'PROCESSING', displayStatus: 'x' });
    page(flowDeps(async () => ({ kind: 'paid', paymentId: 'p', signature: 's' }), 5000));
    await fillGuest(u);
    await u.click(screen.getByRole('button', { name: 'Place order · ₹549' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/checkout/success/AQ3'));
    expect(polls).toBe(3);
  });

  it('…and when the bank never confirms within the wait', async () => {
    const u = userEvent.setup();
    routes['POST /checkout/initiate'] = () => json({ orderNumber: 'AQ4', status: 'PENDING_PAYMENT', total: 54_900, expiresAt: 'x', razorpay: { keyId: 'k', orderId: 'o', amount: 1, currency: 'INR', name: 'ArtQ', prefill: {} } }, 201);
    routes['POST /checkout/verify'] = () => json({ status: 'PROCESSING' }, 202);
    routes['GET /checkout/status/AQ4'] = () => json({ status: 'PENDING_PAYMENT', paymentStatus: 'PROCESSING', displayStatus: 'x' });
    page(flowDeps(async () => ({ kind: 'paid', paymentId: 'p', signature: 's' })));
    await fillGuest(u);
    await u.click(screen.getByRole('button', { name: 'Place order · ₹549' }));
    expect(await screen.findByRole('heading', { name: 'We’re still confirming your payment' })).toBeTruthy();
    expect(screen.getByText(/We’ll email you as soon as your bank confirms/)).toBeTruthy();
  });

  it('server refusals: a field error lands on its field; the price changed → told and re-quoted; out of stock → back to the cart', async () => {
    const u = userEvent.setup();
    routes['POST /checkout/initiate'] = () => apiError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'shippingAddress.pincode', message: 'This pincode is in Kerala' }]);
    page();
    await fillGuest(u);
    await u.click(screen.getByRole('button', { name: 'Place order · ₹549' }));
    await waitFor(() => expectFieldError('Pincode', 'This pincode is in Kerala'));
    routes['POST /checkout/initiate'] = () => apiError(409, 'PRICE_CHANGED', 'The total changed');
    const before = sent('POST', '/checkout/quote').length;
    await u.click(screen.getByRole('button', { name: 'Place order · ₹549' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/The price or shipping changed/);
    await waitFor(() => expect(sent('POST', '/checkout/quote').length).toBeGreaterThan(before));
    routes['POST /checkout/initiate'] = () => apiError(409, 'OUT_OF_STOCK', 'Out of stock');
    await u.click(screen.getByRole('button', { name: 'Place order · ₹549' }));
    expect(await screen.findByRole('link', { name: 'Review your cart' })).toBeTruthy();
  });
});

describe('signed in', () => {
  it('saved addresses: the default is chosen and quoted; a new address offers saving it', async () => {
    const u = userEvent.setup();
    window.localStorage.setItem(HINT_KEY, '1');
    routes['POST /auth/refresh'] = () => json({ accessToken: 'T', user: { id: 7, name: 'Hema R', email: 'hema@example.com', emailVerified: true, phone: '+919847012345', marketingOptIn: false } });
    routes['GET /me/wishlist'] = () => json({ productIds: [], data: [] });
    const addr: AddressView = { id: 5, label: 'HOME', fullName: 'Hema R', phone: '+919847012345', line1: '12 Rose Villa', line2: null, landmark: null, city: 'Kochi', state: { id: 32, name: 'Kerala' }, pincode: '682011', isDefault: true };
    routes['GET /me/addresses'] = () => json({ data: [addr] });
    page(flowDeps(), new StoreSession({ channel: null, locks: null }));
    expect(await screen.findByText('hema@example.com')).toBeTruthy();
    expect((screen.getByLabelText('Mobile number') as HTMLInputElement).value).toBe('+919847012345');
    await waitFor(() => expect(sent('POST', '/checkout/quote').at(-1)?.body).toEqual({ shippingAddressId: 5, paymentMethod: 'RAZORPAY' }));
    expect(screen.queryByLabelText('Full name')).toBeNull();
    await u.click(screen.getByLabelText('Deliver to a new address'));
    expect(screen.getByLabelText('Save to my addresses')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: /Step 1: Contact/ })).queryByLabelText('Email')).toBeNull();
  });
});
