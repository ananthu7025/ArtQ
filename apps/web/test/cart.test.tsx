// Task 4.5: the cart page and the mini-cart against a fake API: lines (quantity, remove + Undo, move to wishlist,
// warnings), the coupon box (shared rule; a refused code lands on the field), public coupons, the shipping estimate,
// the summary, the empty state and the drawer after an add.
import type { CartView, PublicCoupon } from '@artq/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartPage } from '../components/cart/CartPage';
import { MiniCart } from '../components/cart/MiniCart';
import { SiteToaster } from '../components/layout/SiteToaster';
import { ShopProvider, useShop } from '../components/shop/ShopProvider';
import { API_URL } from '../lib/api';

type Item = CartView['items'][number];
const item = (o: Partial<Item> & { id: number }): Item => ({
  variantId: 100 + o.id, productId: 10 + o.id, productSlug: `p-${o.id}`, productName: `Product ${o.id}`, variantLabel: '100 gm', image: null,
  unitPrice: 49_900, unitMrp: null, quantity: 1, lineTotal: 49_900, maxQuantity: 10, available: true, priceChanged: false, ...o,
});
const totals = (o: Partial<CartView['totals']> = {}): CartView['totals'] => ({
  itemCount: 1, subtotal: 49_900, mrpTotal: 49_900, mrpDiscount: 0, couponDiscount: 0,
  shipping: { amount: null, estimated: true, freeApplied: false, heavySurcharge: 0, pincode: null, problem: null },
  codFee: 0, total: 49_900, savings: 0, freeShippingThreshold: 100_000, freeShippingRemaining: 50_100, ...o,
});
const view = (o: Partial<CartView> = {}): CartView => ({ items: [item({ id: 1 })], coupon: null, warnings: [], totals: totals(), ...o });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (status: number, code: string, message: string, details?: unknown) => json({ error: { code, message, details } }, status);

type Route = (body: unknown, url: string) => Response | Promise<Response>;
let routes: Record<string, Route>;
let calls: { method: string; path: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  routes = { 'GET /cart': () => json(view()), 'GET /cart/coupons': () => json({ data: [] }) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace(API_URL, '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const r = routes[`${method} ${path}`] ?? routes[`${method} ${path.split('?')[0]}`];
    if (!r) throw new TypeError('Failed to fetch');
    return r(body, path);
  }));
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const page = () => render(<ShopProvider><CartPage /><MiniCart /><SiteToaster /></ShopProvider>);
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const axeClean = async (el: Element) => expect((await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

describe('cart page', () => {
  it('empty cart → the empty state with a way to shop', async () => {
    routes['GET /cart'] = () => json(view({ items: [], totals: totals({ itemCount: 0, subtotal: 0, total: 0 }) }));
    page();
    expect(await screen.findByText('Your cart is empty')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Start shopping' }).getAttribute('href')).toBe('/shop');
  });

  it('the API down → a retry that works', async () => {
    const u = userEvent.setup();
    delete routes['GET /cart'];
    page();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    routes['GET /cart'] = () => json(view());
    await u.click(retry);
    expect(await screen.findByRole('link', { name: 'Product 1' })).toBeTruthy();
  });

  it('lines, free-shipping progress and summary; passes axe', async () => {
    routes['GET /cart'] = () => json(view({
      items: [item({ id: 1, unitMrp: 59_900 }), item({ id: 2, quantity: 2, lineTotal: 99_800 })],
      totals: totals({ itemCount: 3, subtotal: 149_700, mrpTotal: 159_700, mrpDiscount: 10_000, total: 149_700, savings: 10_000, freeShippingRemaining: 0, shipping: { ...totals().shipping, freeApplied: true } }),
    }));
    const { container } = page();
    expect(await screen.findByRole('heading', { name: /Your cart \(3 items\)/ })).toBeTruthy();
    expect(screen.getByText('FREE shipping', { exact: false })).toBeTruthy();
    const summary = within(screen.getByRole('region', { name: 'Order summary' }));
    expect(summary.getByText('Total').nextElementSibling!.textContent).toBe('₹1,497');
    expect(summary.getByText('MRP total').nextElementSibling!.textContent).toBe('₹1,597');
    expect(summary.getByText('You save ₹100 on this order')).toBeTruthy();
    expect(summary.getByText('Free')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Checkout' }).getAttribute('href')).toBe('/checkout');
    await axeClean(container);
  });

  it('quantity: + and − send the new quantity; + stops at what is available; a stock error shows on the line', async () => {
    const u = userEvent.setup();
    routes['GET /cart'] = () => json(view({ items: [item({ id: 1, quantity: 2, maxQuantity: 3 })] }));
    routes['PATCH /cart/items/1'] = (b) => json(view({ items: [item({ id: 1, quantity: (b as { quantity: number }).quantity, maxQuantity: 3 })] }));
    page();
    await u.click(await screen.findByRole('button', { name: 'One more Product 1 (100 gm)' }));
    await waitFor(() => expect(sent('PATCH', '/cart/items/1')[0]?.body).toEqual({ quantity: 3 }));
    expect((screen.getByRole('button', { name: 'One more Product 1 (100 gm)' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Only 3 available.')).toBeTruthy();
    routes['PATCH /cart/items/1'] = () => apiError(409, 'OUT_OF_STOCK', 'Only 1 left');
    await u.click(screen.getByRole('button', { name: 'One less Product 1 (100 gm)' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Only 1 left');
  });

  it('remove → toast with Undo, which adds the same quantity back', async () => {
    const u = userEvent.setup();
    routes['GET /cart'] = () => json(view({ items: [item({ id: 1, quantity: 2 })] }));
    routes['DELETE /cart/items/1'] = () => json(view({ items: [], totals: totals({ itemCount: 0, subtotal: 0, total: 0 }) }));
    routes['POST /cart/items'] = () => json(view({ items: [item({ id: 3, quantity: 2 })] }), 201);
    page();
    await u.click(await screen.findByRole('button', { name: 'Remove Product 1 (100 gm)' }));
    expect(await screen.findByText('Your cart is empty')).toBeTruthy();
    await u.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(sent('POST', '/cart/items')[0]?.body).toEqual({ variantId: 101, quantity: 2 }));
    expect(await screen.findByRole('link', { name: 'Product 3' })).toBeTruthy();
  });

  it('move to wishlist: saved (guest list) and removed from the cart; already-saved items do not offer it', async () => {
    const u = userEvent.setup();
    window.localStorage.setItem('aq_wishlist', '[12]');
    routes['GET /cart'] = () => json(view({ items: [item({ id: 1 }), item({ id: 2 })], totals: totals({ itemCount: 2 }) }));
    routes['DELETE /cart/items/1'] = () => json(view({ items: [item({ id: 2 })] }));
    page();
    await u.click(await screen.findByRole('button', { name: 'Move Product 1 (100 gm) to your wishlist' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('aq_wishlist')!)).toEqual([11, 12]));
    expect(sent('DELETE', '/cart/items/1')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Move Product 2 (100 gm) to your wishlist' })).toBeNull();
    expect(await screen.findByText('Moved Product 1 to your wishlist')).toBeTruthy();
  });

  it('changes since added are explained; an unavailable item blocks checkout until removed', async () => {
    routes['GET /cart'] = () => json(view({
      items: [item({ id: 1, available: false, lineTotal: 0, maxQuantity: 0, warning: 'No longer available' }), item({ id: 2, priceChanged: true, warning: 'Price changed from ₹449 to ₹499' })],
      warnings: ['Product 1 (100 gm): No longer available', 'Product 2 (100 gm): Price changed from ₹449 to ₹499'],
    }));
    page();
    expect(await screen.findByText('Some items changed since you added them')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'One more Product 1 (100 gm)' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Remove the items that are no longer available to continue.');
    expect((screen.getByRole('button', { name: 'Checkout' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('coupon box', () => {
  it('empty → message under the field (shared rule); a refused code → its reason under the field; applied → code, saving, remove', async () => {
    const u = userEvent.setup();
    page();
    const code = await screen.findByLabelText('Coupon code');
    await u.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(code.getAttribute('aria-invalid')).toBe('true'));
    expect(document.getElementById('coupon-code-error')!.textContent).toBe('Enter a coupon code');
    routes['POST /cart/coupon'] = () => apiError(422, 'COUPON_MIN_ORDER', 'Add ₹100 more of eligible items to use this coupon', { shortBy: 10_000 });
    await u.type(code, 'big100');
    await u.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(document.getElementById('coupon-code-error')!.textContent).toBe('Add ₹100 more of eligible items to use this coupon'));
    expect(sent('POST', '/cart/coupon')[0]!.body).toEqual({ code: 'BIG100' });
    routes['POST /cart/coupon'] = () => json(view({ coupon: { code: 'WELCOME10', title: 'Welcome', summary: '10% off', type: 'PERCENT', applied: true, discount: 4_990, freeShipping: false, problem: null }, totals: totals({ couponDiscount: 4_990, total: 44_910 }) }));
    routes['DELETE /cart/coupon'] = () => json(view());
    await u.clear(code);
    await u.type(code, 'welcome10{Enter}');
    expect(await screen.findByText('You save ₹49.90')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Order summary' })).getByText('−₹49.90')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Remove coupon WELCOME10' }));
    expect(await screen.findByLabelText('Coupon code')).toBeTruthy();
  });

  it('a coupon that no longer qualifies stays with its reason; public coupons can be applied, or say why not', async () => {
    const u = userEvent.setup();
    routes['GET /cart'] = () => json(view({ coupon: { code: 'BIG100', title: 'Big', summary: '₹100 off on orders of ₹1,000 or more', type: 'FLAT', applied: false, discount: 0, freeShipping: false, problem: { code: 'COUPON_MIN_ORDER', message: 'Add ₹501 more of eligible items to use this coupon', shortBy: 50_100 } } }));
    const offers: PublicCoupon[] = [
      { code: 'SHIPFREE', title: 'Free delivery', description: null, type: 'FREE_SHIPPING', value: 0, maxDiscount: null, minOrderValue: 0, endsAt: null, eligible: true, reason: null },
      { code: 'BIG100', title: 'Big', description: null, type: 'FLAT', value: 10_000, maxDiscount: null, minOrderValue: 100_000, endsAt: null, eligible: false, reason: 'Add ₹501 more of eligible items to use this coupon' },
    ];
    routes['GET /cart/coupons'] = () => json({ data: offers });
    routes['POST /cart/coupon'] = () => json(view());
    page();
    expect(await screen.findByText('Add ₹501 more of eligible items to use this coupon', { selector: 'p.text-warning-ink' })).toBeTruthy();
    await u.click(await screen.findByText('Available coupons (2)'));
    expect(screen.getByText('Applied')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Apply SHIPFREE' }));
    await waitFor(() => expect(sent('POST', '/cart/coupon')[0]?.body).toEqual({ code: 'SHIPFREE' }));
  });
});

describe('shipping estimate', () => {
  it('a bad pincode → message under the field; a good one is remembered and every cart call carries it; problems are explained', async () => {
    const u = userEvent.setup();
    routes['GET /cart'] = (_b, url) => json(view(url.includes('pincode=682011')
      ? { totals: totals({ total: 54_900, shipping: { amount: 5000, estimated: false, freeApplied: false, heavySurcharge: 0, pincode: '682011', problem: null } }) }
      : url.includes('pincode=744101') ? { totals: totals({ shipping: { amount: null, estimated: true, freeApplied: false, heavySurcharge: 0, pincode: '744101', problem: 'SHIPPING_RESTRICTED' } }) } : {}));
    page();
    const pin = await screen.findByLabelText('Pincode');
    await u.type(pin, '0682');
    await u.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(document.getElementById('cart-pincode-error')!.textContent).toBe('Enter a 6-digit pincode'));
    await u.clear(pin);
    await u.type(pin, '682011{Enter}');
    expect(await screen.findByText('Shipping ₹50')).toBeTruthy();
    expect(window.localStorage.getItem('aq_pincode')).toBe('682011');
    expect(within(screen.getByRole('region', { name: 'Order summary' })).getByText('₹549')).toBeTruthy();
    routes['PATCH /cart/items/1'] = () => json(view());
    await u.click(screen.getByRole('button', { name: 'One more Product 1 (100 gm)' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/cart/items/1?pincode=682011')).toBe(true));
    await u.click(screen.getByRole('button', { name: 'Change pincode 682011' }));
    await u.clear(screen.getByLabelText('Pincode'));
    await u.type(screen.getByLabelText('Pincode'), '744101{Enter}');
    expect(await screen.findByText('Some items (like resin) travel by road only and can’t be delivered to this pincode.')).toBeTruthy();
  });
});

describe('mini-cart', () => {
  function AddButton({ quiet }: { quiet?: boolean }) {
    const { addToCart } = useShop();
    return <button type="button" onClick={() => void addToCart(101, 2, 'Product 1 (100 gm)', quiet ? { quiet } : undefined)}>Add it</button>;
  }
  it('opens after an add with the item, subtotal and free-shipping progress; View cart / Checkout; Esc closes; passes axe', async () => {
    const u = userEvent.setup();
    routes['GET /cart'] = () => json(view({ items: [], totals: totals({ itemCount: 0, subtotal: 0, total: 0 }) }));
    routes['POST /cart/items'] = () => json(view({ items: [item({ id: 1, quantity: 2, lineTotal: 99_800 })], totals: totals({ itemCount: 2, subtotal: 99_800, total: 99_800, freeShippingRemaining: 200 }) }), 201);
    render(<ShopProvider><AddButton /><MiniCart /></ShopProvider>);
    await u.click(screen.getByRole('button', { name: 'Add it' }));
    const drawer = within(await screen.findByRole('dialog', { name: 'Added to your cart' }));
    expect(drawer.getByText('Added 2 × Product 1 (100 gm) to your cart')).toBeTruthy();
    expect(drawer.getByText('2 × ₹499')).toBeTruthy();
    expect(drawer.getByText('Cart subtotal (2 items)')).toBeTruthy();
    expect(drawer.getByText('₹2', { exact: false })).toBeTruthy();
    expect(drawer.getByRole('link', { name: 'View cart' }).getAttribute('href')).toBe('/cart');
    expect(drawer.getByRole('link', { name: 'Checkout' }).getAttribute('href')).toBe('/checkout');
    await axeClean(document.body);
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('Buy now (quiet) adds without opening it', async () => {
    const u = userEvent.setup();
    routes['POST /cart/items'] = () => json(view(), 201);
    render(<ShopProvider><AddButton quiet /><MiniCart /></ShopProvider>);
    await u.click(screen.getByRole('button', { name: 'Add it' }));
    await waitFor(() => expect(sent('POST', '/cart/items')).toHaveLength(1));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
