// Task 3.4: card actions (ADD / OPTIONS / NOTIFY ME, ♡), the quick-add sheet and the shop context (cart count,
// guest wishlist), against a fake API.
import type { Availability, CartView, ProductCard, ProductDetail } from '@artq/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiniCart } from '../components/cart/MiniCart';
import { Header } from '../components/layout/Header';
import { SiteToaster } from '../components/layout/SiteToaster';
import { ProductCard as Card } from '../components/product/ProductCard';
import { ShopProvider } from '../components/shop/ShopProvider';
import { API_URL } from '../lib/api';

const card = (o: Partial<ProductCard> & { id: number; name: string }): ProductCard => ({
  slug: `p-${o.id}`, image: null, hoverImage: null, fromPrice: 19_000, maxPrice: 19_000, mrp: null, discountPercent: null, inStock: true, isNew: false, isTrending: false,
  variantCount: 1, defaultVariantId: 100 + o.id, type: { slug: 'pigments', name: 'Pigments' }, ...o,
});
const v = (id: number, size: string, color: string | null, price: number) => ({ id, sku: `S${id}`, label: [size, color].filter(Boolean).join(' / '), size, color, colorHex: color === 'Gold' ? '#D4AF37' : color ? '#C0C0C0' : null, thickness: null, price, mrp: null, discountPercent: null, image: null });
const MICA: ProductDetail = {
  id: 2, slug: 'mica', name: 'Mica Pigment', shortDescription: null, description: null, type: { slug: 'pigments', name: 'Pigments' }, category: null, images: [],
  variants: [v(21, '10 gm', 'Gold', 19_000), v(22, '10 gm', 'Silver', 19_000), v(23, '50 gm', 'Gold', 49_000), v(24, '50 gm', 'Silver', 49_000)],
  options: { size: ['10 gm', '50 gm'], color: [{ name: 'Gold', hex: '#D4AF37' }, { name: 'Silver', hex: '#C0C0C0' }], thickness: [] },
  fromPrice: 19_000, maxPrice: 49_000, isNew: false, isTrending: false,
  productDetails: [], specificationsCare: [], howToUse: null, specifications: [], techniques: [], video: null, metaTitle: null, metaDescription: null, inStock: true,
};
// 10 gm Gold sold out; 50 gm Silver sold out; 10 gm Silver 3 left.
const MICA_STOCK: Availability = { variants: [
  { id: 21, price: 19_000, mrp: null, discountPercent: null, stockStatus: 'OUT_OF_STOCK', maxQuantity: 0 }, { id: 22, price: 19_000, mrp: null, discountPercent: null, stockStatus: 'LOW_STOCK', maxQuantity: 3 },
  { id: 23, price: 49_000, mrp: null, discountPercent: null, stockStatus: 'IN_STOCK', maxQuantity: 50 }, { id: 24, price: 49_000, mrp: null, discountPercent: null, stockStatus: 'OUT_OF_STOCK', maxQuantity: 0 },
] };
const cartView = (itemCount: number): CartView => ({ items: [], coupon: null, warnings: [], totals: { itemCount, subtotal: 0, mrpTotal: 0, mrpDiscount: 0, couponDiscount: 0, shipping: { amount: null, estimated: true, freeApplied: false, heavySurcharge: 0, pincode: null, problem: null }, codFee: 0, total: 0, savings: 0, freeShippingThreshold: 100_000, freeShippingRemaining: 100_000 } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (status: number, code: string, message: string, details?: unknown) => json({ error: { code, message, details } }, status);

type Route = (init: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Route>;
let calls: { method: string; path: string; body: unknown; init: RequestInit }[];
beforeEach(() => {
  calls = [];
  routes = { 'GET /cart': () => json(cartView(0)) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace(API_URL, '');
    const method = init.method ?? 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined, init });
    const r = routes[`${method} ${path}`];
    if (!r) throw new TypeError('Failed to fetch');
    return r(init);
  }));
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const page = (cards: ProductCard[]) => render(<ShopProvider><Header navigation={{ types: [] }} /><ul>{cards.map((c) => <li key={c.id}><Card card={c} /></li>)}</ul><MiniCart /><SiteToaster /></ShopProvider>);
const axeClean = async (el: Element) => expect((await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

describe('cart count and direct ADD', () => {
  it('the header shows the cart count from the API; ADD on a one-size card adds 1 with cookies and updates the count', async () => {
    const u = userEvent.setup();
    routes['GET /cart'] = () => json(cartView(2));
    routes['POST /cart/items'] = () => json(cartView(3), 201);
    page([card({ id: 1, name: 'UV Curing Light' })]);
    expect(await screen.findByRole('link', { name: 'Cart, 2 items' })).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Add UV Curing Light to cart' }));
    const drawer = await screen.findByRole('dialog', { name: 'Added to your cart' });   // the mini-cart (product.md §5.7)
    expect(within(drawer).getByText('Added UV Curing Light to your cart')).toBeTruthy();
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('link', { name: 'Cart, 3 items' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add UV Curing Light to cart' }));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post).toMatchObject({ path: '/cart/items', body: { variantId: 101, quantity: 1 } });
    expect(post.init).toMatchObject({ credentials: 'include', cache: 'no-store' });
  });

  it('cart unreachable on load → count stays 0, the page still works', async () => {
    delete routes['GET /cart'];
    page([card({ id: 1, name: 'UV Curing Light' })]);
    await waitFor(() => expect(calls.some((c) => c.path === '/cart')).toBe(true));
    expect(screen.getByRole('link', { name: 'Cart, 0 items' })).toBeTruthy();
  });

  it('ADD refused: a limit message as a toast; sold out meanwhile → the sheet opens with Notify me', async () => {
    const u = userEvent.setup();
    routes['POST /cart/items'] = () => apiError(422, 'QUANTITY_LIMIT', 'You can buy at most 50 of one item');
    page([card({ id: 1, name: 'UV Curing Light' })]);
    await u.click(screen.getByRole('button', { name: 'Add UV Curing Light to cart' }));
    expect(await screen.findByText('You can buy at most 50 of one item')).toBeTruthy();
    routes['POST /cart/items'] = () => apiError(409, 'OUT_OF_STOCK', 'This option is out of stock', { available: 0, inCart: 0 });
    routes['GET /products/p-1'] = () => json({ ...MICA, slug: 'p-1', name: 'UV Curing Light', variants: [v(101, '1 unit', null, 19_000)], options: { size: [], color: [], thickness: [] } });
    routes['GET /products/p-1/availability'] = () => json({ variants: [{ id: 101, price: 19_000, mrp: null, discountPercent: null, stockStatus: 'OUT_OF_STOCK', maxQuantity: 0 }] });
    await u.click(screen.getByRole('button', { name: 'Add UV Curing Light to cart' }));
    const sheet = await screen.findByRole('dialog', { name: 'UV Curing Light' });
    expect(await within(sheet).findByRole('button', { name: 'Notify me' })).toBeTruthy();
  });
});

describe('quick-add sheet (several sizes)', () => {
  beforeEach(() => {
    routes['GET /products/mica'] = () => json(MICA);
    routes['GET /products/mica/availability'] = () => json(MICA_STOCK);
  });
  const open = async (u: ReturnType<typeof userEvent.setup>) => {
    page([card({ id: 2, slug: 'mica', name: 'Mica Pigment', variantCount: 4, defaultVariantId: null, fromPrice: 19_000, maxPrice: 49_000 })]);
    await u.click(screen.getByRole('button', { name: 'Options for Mica Pigment' }));
    const sheet = await screen.findByRole('dialog', { name: 'Mica Pigment' });
    await within(sheet).findByRole('group', { name: /Size/ });
    return sheet;
  };

  it('opens on the cheapest size in stock; sold-out combinations are crossed out and say so; passes axe', async () => {
    const u = userEvent.setup();
    const sheet = await open(u);
    expect(within(sheet).getByRole('button', { name: '10 gm' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(sheet).getByRole('button', { name: 'Silver' }).getAttribute('aria-pressed')).toBe('true');   // 10 gm Gold is sold out
    expect(within(sheet).getByText('Only a few left')).toBeTruthy();
    const gold = within(sheet).getByRole('button', { name: 'Gold, sold out' });   // selectable (leads to Notify me), so not aria-disabled
    expect(gold.getAttribute('aria-disabled')).toBeNull();
    expect(gold.className).toContain('line-through');
    expect(within(sheet).getByRole('group', { name: 'Colour: Silver' })).toBeTruthy();
    await axeClean(sheet);
  });

  it('quantity stops at what is in stock; Add sends the chosen size and quantity, the mini-cart opens; closing it returns focus to the pill', async () => {
    const u = userEvent.setup();
    routes['POST /cart/items'] = () => json(cartView(3), 201);
    const sheet = await open(u);
    const plus = within(sheet).getByRole('button', { name: 'Increase quantity' });
    await u.click(plus); await u.click(plus); await u.click(plus);
    expect(within(sheet).getByRole('group', { name: 'Quantity' }).textContent).toContain('3');
    expect((plus as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByText('Only 3 available')).toBeTruthy();
    await u.click(within(sheet).getByRole('button', { name: 'Add to cart · ₹570' }));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ variantId: 22, quantity: 3 });
    const drawer = await screen.findByRole('dialog', { name: 'Added to your cart' });   // the sheet closed, the mini-cart opened
    expect(within(drawer).getByText('Added 3 × Mica Pigment (10 gm / Silver) to your cart')).toBeTruthy();
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Options for Mica Pigment' })));
  });

  it('changing size resets the quantity; a refusal from the API is shown in the sheet', async () => {
    const u = userEvent.setup();
    routes['POST /cart/items'] = () => apiError(409, 'OUT_OF_STOCK', 'Only 1 left (you already have 2 in your cart)', { available: 1, inCart: 2 });
    const sheet = await open(u);
    await u.click(within(sheet).getByRole('button', { name: 'Increase quantity' }));
    await u.click(within(sheet).getByRole('button', { name: '50 gm, sold out' }));   // 50 gm Silver is sold out
    await u.click(within(sheet).getByRole('button', { name: 'Gold' }));
    expect(within(sheet).getByRole('group', { name: 'Quantity' }).textContent).toContain('1');
    await u.click(within(sheet).getByRole('button', { name: 'Add to cart · ₹490' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Only 1 left (you already have 2 in your cart)');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a sold-out choice offers Notify me: empty → field message; saved → confirmation; already → says so', async () => {
    const u = userEvent.setup();
    let answer = { status: 'SUBSCRIBED' };
    routes['POST /products/mica/notify'] = () => json(answer, 201);
    const sheet = await open(u);
    await u.click(within(sheet).getByRole('button', { name: 'Gold, sold out' }));
    expect(within(sheet).queryByRole('button', { name: /Add to cart/ })).toBeNull();
    await u.click(within(sheet).getByRole('button', { name: 'Notify me' }));
    await waitFor(() => {
      const f = within(sheet).getByLabelText('Email address');
      expect(f.getAttribute('aria-invalid')).toBe('true');
      expect(document.getElementById('notify-email-error')!.textContent).toBe('Enter your email address');
    });
    await u.type(within(sheet).getByLabelText('Email address'), 'maker@example.com');
    await u.click(within(sheet).getByRole('button', { name: 'Notify me' }));
    expect((await within(sheet).findByRole('status')).textContent).toBe('We’ll email you when 10 gm / Gold is back in stock.');
    expect(calls.find((c) => c.path === '/products/mica/notify')!.body).toEqual({ variantId: 21, email: 'maker@example.com' });
    answer = { status: 'ALREADY_SUBSCRIBED' };
    await u.click(within(sheet).getByRole('button', { name: '50 gm' }));
    await u.click(within(sheet).getByRole('button', { name: 'Silver, sold out' }));
    await u.type(within(sheet).getByLabelText('Email address'), 'maker@example.com{Enter}');
    expect((await within(sheet).findByRole('status')).textContent).toBe('You’re already on the list for 50 gm / Silver.');
  });

  it('Notify me: server field error lands on the field; "back in stock" is explained', async () => {
    const u = userEvent.setup();
    let reply = () => apiError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'email', message: 'Enter a valid email address' }]);
    routes['POST /products/mica/notify'] = () => reply();
    const sheet = await open(u);
    await u.click(within(sheet).getByRole('button', { name: 'Gold, sold out' }));
    await u.type(within(sheet).getByLabelText('Email address'), 'maker@example.com{Enter}');
    await waitFor(() => expect(within(sheet).getByLabelText('Email address').getAttribute('aria-invalid')).toBe('true'));
    reply = () => apiError(409, 'IN_STOCK', 'This option is in stock', { available: 2 });
    await u.click(within(sheet).getByRole('button', { name: 'Notify me' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Good news: this is back in stock. Close this and add it to your cart.');
  });

  it('an option that does not exist with the other choices moves them to the nearest real combination (in stock first)', async () => {
    const u = userEvent.setup();
    routes['GET /products/mica'] = () => json({ ...MICA, variants: [...MICA.variants, v(25, '100 gm', 'Gold', 89_000)], options: { ...MICA.options, size: ['10 gm', '50 gm', '100 gm'] } });
    routes['GET /products/mica/availability'] = () => json({ variants: [...MICA_STOCK.variants, { id: 25, price: 89_000, mrp: null, discountPercent: null, stockStatus: 'IN_STOCK', maxQuantity: 9 }] });
    const sheet = await open(u);                                       // 10 gm / Silver
    const big = within(sheet).getByRole('button', { name: '100 gm, other options will change' });
    expect(big.className).toContain('border-dashed');
    await u.click(big);
    expect(within(sheet).getByRole('button', { name: 'Gold' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(sheet).getByRole('button', { name: /^Add to cart · ₹890$/ })).toBeTruthy();
  });

  it('prices and stock cannot be loaded → says so and offers no Add (fails closed)', async () => {
    const u = userEvent.setup();
    routes['GET /products/mica/availability'] = () => apiError(500, 'INTERNAL', 'x');
    page([card({ id: 2, slug: 'mica', name: 'Mica Pigment', variantCount: 4, defaultVariantId: null })]);
    await u.click(screen.getByRole('button', { name: 'Options for Mica Pigment' }));
    const sheet = await screen.findByRole('dialog', { name: 'Mica Pigment' });
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Prices and stock are temporarily unavailable. Please try again in a moment.');
    expect(within(sheet).queryByRole('button', { name: /Add to cart/ })).toBeNull();
  });
});

describe('sold-out card and wishlist', () => {
  it('a sold-out card says NOTIFY ME (outlined) and opens the sheet', async () => {
    const u = userEvent.setup();
    routes['GET /products/mica'] = () => json(MICA);
    routes['GET /products/mica/availability'] = () => json({ variants: MICA_STOCK.variants.map((x) => ({ ...x, stockStatus: 'OUT_OF_STOCK', maxQuantity: 0 })) });
    page([card({ id: 2, slug: 'mica', name: 'Mica Pigment', inStock: false, variantCount: 4, defaultVariantId: null })]);
    const pill = screen.getByRole('button', { name: 'Notify me about Mica Pigment' });
    expect(pill.className).toContain('border-ink-900');
    await u.click(pill);
    expect(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Notify me' })).toBeTruthy();
  });

  it('♡ saves to the guest wishlist (this browser), counts in the header, survives a reload, follows other tabs', async () => {
    const u = userEvent.setup();
    const { unmount } = page([card({ id: 1, name: 'UV Curing Light' }), card({ id: 2, name: 'Mica Gold' })]);
    const heart = screen.getByRole('button', { name: 'Save UV Curing Light to wishlist' });
    await u.click(heart);
    expect(screen.getByRole('button', { name: 'Remove UV Curing Light from wishlist' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('link', { name: 'Wishlist, 1 item' })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('aq_wishlist')!)).toEqual([1]);
    expect(await screen.findByText('Saved UV Curing Light to your wishlist')).toBeTruthy();
    unmount();
    page([card({ id: 1, name: 'UV Curing Light' }), card({ id: 2, name: 'Mica Gold' })]);
    expect(screen.getByRole('link', { name: 'Wishlist, 1 item' })).toBeTruthy();
    act(() => {
      window.localStorage.setItem('aq_wishlist', JSON.stringify([2, 1]));
      window.dispatchEvent(new StorageEvent('storage', { key: 'aq_wishlist' }));
    });
    expect(screen.getByRole('link', { name: 'Wishlist, 2 items' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Mica Gold from wishlist' })).toBeTruthy();
  });

  it('a damaged stored wishlist is treated as empty instead of breaking the page', () => {
    window.localStorage.setItem('aq_wishlist', '{"not":"a list"');
    page([card({ id: 1, name: 'UV Curing Light' })]);
    expect(screen.getByRole('link', { name: 'Wishlist, 0 items' })).toBeTruthy();
    window.localStorage.setItem('aq_wishlist', JSON.stringify([1, 'x', -3, 1.5]));
    fireEvent(window, new StorageEvent('storage', { key: 'aq_wishlist' }));
    expect(screen.getByRole('link', { name: 'Wishlist, 1 item' })).toBeTruthy();
  });
});
