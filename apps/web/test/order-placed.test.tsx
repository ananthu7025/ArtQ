// Task 4.10: the confirmation page against a fake API: the placed order (items, totals, payment, address, estimate),
// "Set a password" for guests, the processing state polling the status, not-found / errors / closed orders, and the
// analytics `purchase` event (once, only for PLACED).
import type { OrderConfirmation } from '@artq/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../components/account/AuthProvider';
import { OrderPlacedView } from '../components/checkout/OrderPlacedView';
import { trackPurchase } from '../lib/analytics';
import { API_URL } from '../lib/api';
import { HINT_KEY, StoreSession } from '../lib/session';

const ORDER: OrderConfirmation = {
  orderNumber: 'AQ10234', status: 'PLACED', paymentStatus: 'COD_PENDING', displayStatus: 'Order placed', paymentMethod: 'COD', firstName: 'Hema', contactEmail: 'hema@example.com',
  items: [{ name: 'Epoxy Resin', label: '500 ml', quantity: 2, lineTotal: 99_800, imageUrl: null }],
  totals: { subtotal: 99_800, couponDiscount: 5000, couponCode: 'WELCOME10', shipping: 7000, codFee: 4000, total: 105_800 },
  address: { name: 'Hema R', lines: ['12 Rose Villa', 'Kochi, Kerala 682011'] }, estimatedDays: { min: 4, max: 7 }, canSetPassword: true,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
type DL = { dataLayer?: Record<string, unknown>[] };

let routes: Record<string, () => Response | Promise<Response>>;
let calls: { method: string; path: string; headers: Record<string, string> }[];
beforeEach(() => {
  calls = [];
  routes = { 'GET /checkout/orders/AQ10234': () => json(ORDER) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace(API_URL, '');
    const method = init.method ?? 'GET';
    calls.push({ method, path, headers: (init.headers ?? {}) as Record<string, string> });
    const r = routes[`${method} ${path}`];
    if (!r) throw new TypeError('Failed to fetch');
    return r();
  }));
  window.localStorage.clear();
  delete (window as DL).dataLayer;
});
afterEach(() => vi.unstubAllGlobals());
const purchases = () => ((window as DL).dataLayer ?? []).filter((e) => e.event === 'purchase');
const axeClean = async (el: Element) => expect((await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => x.id)).toEqual([]);

describe('order placed page', () => {
  it('shows the order: thanks by name, items, totals with coupon / shipping / COD fee, payment, address, delivery days; fires purchase once', async () => {
    const { container, unmount } = render(<OrderPlacedView orderNumber="AQ10234" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Thank you, Hema! Your order is placed.' })).toBe(document.activeElement);
    expect(screen.getByText(/emailed the confirmation to hema@example.com/)).toBeTruthy();
    const items = screen.getByRole('region', { name: 'Your items' });
    expect(within(items).getByText('Epoxy Resin')).toBeTruthy();
    expect(within(items).getByText('500 ml · Qty 2')).toBeTruthy();
    expect(within(items).getByText('Coupon WELCOME10').nextSibling?.textContent).toBe('−₹50');
    expect(within(items).getByText('Cash on delivery fee').nextSibling?.textContent).toBe('₹40');
    expect(within(items).getByText('Total').nextSibling?.textContent).toBe('₹1,058');
    expect(screen.getByText('Cash on delivery: please keep ₹1,058 ready.')).toBeTruthy();
    expect(screen.getByText('4–7 days after dispatch')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Delivering to' })).getByText('Kochi, Kerala 682011')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Continue shopping' }).getAttribute('href')).toBe('/shop');
    expect(purchases()).toEqual([{ event: 'purchase', ecommerce: { transaction_id: 'AQ10234', currency: 'INR', value: 1058, shipping: 70, coupon: 'WELCOME10', payment_type: 'cod', items: [{ item_name: 'Epoxy Resin', item_variant: '500 ml', quantity: 2, price: 499 }] } }]);
    await axeClean(container);
    unmount();
    render(<OrderPlacedView orderNumber="AQ10234" />);                       // reload: no second purchase
    await screen.findByRole('heading', { level: 1, name: /Thank you/ });
    expect(purchases()).toHaveLength(1);
  });

  it('guest "Set a password": sends the link once and confirms; a server error shows under the button', async () => {
    const u = userEvent.setup();
    let n = 0;
    routes['POST /checkout/orders/AQ10234/set-password-link'] = () => (++n === 1 ? apiError(429, 'RATE_LIMITED', 'slow') : json({ sent: true }));
    render(<OrderPlacedView orderNumber="AQ10234" />);
    await u.click(await screen.findByRole('button', { name: 'Set a password' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Too many tries. Please wait a minute and try again.');
    await u.click(screen.getByRole('button', { name: 'Set a password' }));
    expect((await screen.findByRole('status')).textContent).toBe('Link sent. Check your inbox at hema@example.com.');
    expect(screen.queryByRole('button', { name: 'Set a password' })).toBeNull();
    expect(n).toBe(2);
  });

  it('no "Set a password" when the email already has one, or for a signed-in customer (who gets "Your account")', async () => {
    routes['GET /checkout/orders/AQ10234'] = () => json({ ...ORDER, canSetPassword: false });
    const { unmount } = render(<OrderPlacedView orderNumber="AQ10234" />);
    await screen.findByRole('heading', { level: 1, name: /Thank you/ });
    expect(screen.queryByRole('button', { name: 'Set a password' })).toBeNull();
    unmount();
    routes['GET /checkout/orders/AQ10234'] = () => json(ORDER);
    calls = [];
    window.localStorage.setItem(HINT_KEY, '1');
    routes['POST /auth/refresh'] = () => json({ accessToken: 'T', user: { id: 7, name: 'Hema R', email: 'hema@example.com', emailVerified: true, phone: null, marketingOptIn: false } });
    render(<AuthProvider session={new StoreSession({ channel: null, locks: null })}><OrderPlacedView orderNumber="AQ10234" /></AuthProvider>);
    await screen.findByRole('heading', { level: 1, name: /Thank you/ });
    expect(screen.queryByRole('button', { name: 'Set a password' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Your account' })).toBeTruthy();
    // The order loads only after the session is restored, with the customer's token.
    const get = calls.findIndex((c) => c.path === '/checkout/orders/AQ10234');
    expect(get).toBeGreaterThan(calls.findIndex((c) => c.path === '/auth/refresh'));
    expect(calls[get]!.headers.Authorization).toBe('Bearer T');
  });

  it('payment still processing: polls the status, then shows the placed order; no purchase event before that', async () => {
    let placed = false;
    let polls = 0;
    routes['GET /checkout/orders/AQ10234'] = () => json(placed ? { ...ORDER, paymentMethod: 'RAZORPAY', codFee: 0 } : { ...ORDER, status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', paymentMethod: 'RAZORPAY' });
    routes['GET /checkout/status/AQ10234'] = () => { if (++polls === 2) placed = true; return json({ status: placed ? 'PLACED' : 'PENDING_PAYMENT', paymentStatus: 'X', displayStatus: 'X' }); };
    render(<OrderPlacedView orderNumber="AQ10234" pollMs={5} pollForMs={2000} />);
    expect(await screen.findByRole('heading', { name: 'Payment processing' })).toBeTruthy();
    expect(purchases()).toHaveLength(0);
    expect(await screen.findByRole('heading', { level: 1, name: /Thank you/ })).toBeTruthy();
    expect(screen.getByText('Paid online.')).toBeTruthy();
    expect(polls).toBe(2);
    expect(purchases()).toHaveLength(1);
  });

  it('gives up after the polling window with "we’ll email you"; a failing status call keeps polling', async () => {
    routes['GET /checkout/orders/AQ10234'] = () => json({ ...ORDER, status: 'PENDING_PAYMENT' });
    let polls = 0;
    routes['GET /checkout/status/AQ10234'] = () => { polls++; throw new TypeError('Failed to fetch'); };
    render(<OrderPlacedView orderNumber="AQ10234" pollMs={5} pollForMs={300} />);   // wide enough to see several polls under load
    expect(await screen.findByRole('heading', { name: 'We’re still confirming your payment' })).toBeTruthy();
    expect(screen.getByText(/We’ll email hema@example.com as soon as your bank confirms/)).toBeTruthy();
    expect(polls).toBeGreaterThan(1);
  });

  it('an expired or cancelled order says it was not completed; no purchase event', async () => {
    for (const status of ['EXPIRED', 'CANCELLED'] as const) {
      routes['GET /checkout/orders/AQ10234'] = () => json({ ...ORDER, status });
      const { unmount } = render(<OrderPlacedView orderNumber="AQ10234" />);
      expect(await screen.findByRole('heading', { name: 'This order was not completed' })).toBeTruthy();
      unmount();
    }
    expect(purchases()).toHaveLength(0);
  });

  it('another browser’s order: "We couldn’t find this order"; a network failure offers Try again, which recovers', async () => {
    routes['GET /checkout/orders/AQ10234'] = () => apiError(404, 'NOT_FOUND', 'Order not found');
    const { unmount } = render(<OrderPlacedView orderNumber="AQ10234" />);
    expect(await screen.findByRole('heading', { name: 'We couldn’t find this order' })).toBeTruthy();
    unmount();
    const u = userEvent.setup();
    let fail = true;
    routes['GET /checkout/orders/AQ10234'] = () => { if (fail) throw new TypeError('Failed to fetch'); return json(ORDER); };
    render(<OrderPlacedView orderNumber="AQ10234" />);
    expect(await screen.findByRole('heading', { name: 'We couldn’t load your order' })).toBeTruthy();
    fail = false;
    await u.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: /Thank you/ })).toBeTruthy();
  });
});

describe('trackPurchase', () => {
  it('only PLACED counts; each order once; storage off still sends; no coupon key without a coupon', () => {
    expect(trackPurchase({ ...ORDER, status: 'CONFIRMED' })).toBe(false);
    expect(trackPurchase({ ...ORDER, totals: { ...ORDER.totals, couponCode: null, couponDiscount: 0 } })).toBe(true);
    expect(trackPurchase(ORDER)).toBe(false);
    expect(purchases()[0]!.ecommerce).not.toHaveProperty('coupon');
    window.localStorage.setItem('aq_purchase_sent', '{bad json');
    expect(trackPurchase({ ...ORDER, orderNumber: 'AQ2' })).toBe(true);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(trackPurchase({ ...ORDER, orderNumber: 'AQ3' })).toBe(true);
    spy.mockRestore();
    expect(purchases().map((e) => (e.ecommerce as { transaction_id: string }).transaction_id)).toEqual(['AQ10234', 'AQ2', 'AQ3']);
  });
});
