// Task 3.6: the product page — buy box with live stock, gallery, pincode check, recently viewed, JSON-LD.
import type { Availability, MediaRef, ProductDetail } from '@artq/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppButton } from '../components/layout/WhatsAppButton';
import { Gallery } from '../components/product/Gallery';
import { PincodeCheck } from '../components/product/PincodeCheck';
import { ProductView } from '../components/product/ProductView';
import { RecentlyViewed } from '../components/product/RecentlyViewed';
import { ShopProvider } from '../components/shop/ShopProvider';
import { API_URL } from '../lib/api';
import { jsonLdScript, productJsonLd } from '../lib/seo';
import { nav } from './setup';

const img = (id: number): MediaRef => ({ id, url: `https://cdn.test/${id}.webp`, width: 1200, height: 1200, alt: `Photo ${id}`, placeholder: null, srcset: { webp: `https://cdn.test/${id}.webp 1200w` } });
const v = (id: number, size: string, color: string, price: number, image: MediaRef | null = null) => ({ id, sku: `MICA-${id}`, label: `${size} / ${color}`, size, color, colorHex: null, thickness: null, price, mrp: price === 19_000 ? 25_000 : null, discountPercent: price === 19_000 ? 24 : null, image });
const PRODUCT: ProductDetail = {
  id: 7, slug: 'mica', name: 'Mica Pigment', shortDescription: 'Shimmering mica for resin.', description: '<p>Fine <strong>mica</strong>.</p>',
  type: { slug: 'pigments', name: 'Pigments' }, category: { slug: 'mica-powder', name: 'Mica Powder' }, images: [img(1), img(2), img(3)],
  variants: [v(21, '10 gm', 'Gold', 19_000), v(22, '10 gm', 'Silver', 19_000, img(3)), v(23, '50 gm', 'Gold', 49_000)],
  options: { size: ['10 gm', '50 gm'], color: [{ name: 'Gold', hex: null }, { name: 'Silver', hex: null }], thickness: [] },
  fromPrice: 19_000, maxPrice: 49_000, isNew: false, isTrending: false, productDetails: [], specificationsCare: [], howToUse: null, specifications: [],
  techniques: [], video: { id: 9, url: 'https://cdn.test/v.mp4', mime: 'video/mp4', width: null, height: null }, metaTitle: null, metaDescription: null, inStock: true,
};
const STOCK: Availability = { variants: [
  { id: 21, price: 19_000, mrp: 25_000, discountPercent: 24, stockStatus: 'OUT_OF_STOCK', maxQuantity: 0 },
  { id: 22, price: 19_000, mrp: 25_000, discountPercent: 24, stockStatus: 'LOW_STOCK', maxQuantity: 2 },
  { id: 23, price: 49_000, mrp: null, discountPercent: null, stockStatus: 'IN_STOCK', maxQuantity: 50 },
] };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
type Route = () => Response | Promise<Response>;
let routes: Record<string, Route>;
let calls: { method: string; path: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  routes = { 'GET /cart': () => json({ items: [], totals: { itemCount: 0 } }), 'GET /products/mica/availability': () => json(STOCK), 'POST /cart/items': () => json({ items: [], totals: { itemCount: 1 } }, 201) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace(API_URL, ''); const method = init.method ?? 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes[`${method} ${path}`];
    if (!r) throw new TypeError('Failed to fetch');
    return r();
  }));
  window.localStorage.clear();
  window.history.replaceState(null, '', '/product/mica');
});
afterEach(() => vi.unstubAllGlobals());
const axeClean = async (el: Element) => expect((await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
const page = (sku: string | null = null) => render(<ShopProvider><ProductView product={PRODUCT} initialSku={sku} returnWindowHours={48} /><WhatsAppButton number="+91 98470 12345" /></ShopProvider>);

describe('buy box', () => {
  it('cached prices first, then live stock: starts on the cheapest size in stock; price, MRP, % off, taxes note; axe clean', async () => {
    const { container } = page();
    expect(screen.getByText('Checking stock…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add to cart' }) as HTMLButtonElement).disabled).toBe(true);   // never at a stale price
    expect(await screen.findByText('Only a few left')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Silver' }).getAttribute('aria-pressed')).toBe('true');          // 10 gm Gold is sold out
    expect(container.textContent).toContain('₹190MRP ₹25024% OFF');
    expect(screen.getByText('Inclusive of all taxes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gold, sold out' })).toBeTruthy();
    await axeClean(container);
  });

  it('?variant=<sku> opens on that variant; choosing another updates price and the address', async () => {
    const u = userEvent.setup();
    page('MICA-23');
    expect(await screen.findByText('In stock')).toBeTruthy();
    expect(screen.getByRole('button', { name: '50 gm' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).toContain('₹490');
    await u.click(screen.getByRole('button', { name: '10 gm, sold out' }));        // 10 gm Gold
    expect(window.location.search).toBe('?variant=MICA-21');
    expect(screen.getByText('Out of stock')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Notify me' })).toBeTruthy();         // sold out → Notify me instead of Add
    expect(screen.queryByRole('button', { name: 'Add to cart' })).toBeNull();
  });

  it('quantity stops at stock; Add to cart sends variant and quantity; Buy now adds then goes to checkout', async () => {
    const u = userEvent.setup();
    page('MICA-22');
    await screen.findByText('Only a few left');
    const plus = screen.getByRole('button', { name: 'Increase quantity' });
    await u.click(plus); await u.click(plus);
    expect((plus as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Only 2 available')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Add to cart' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ variantId: 22, quantity: 2 });
    await u.click(screen.getByRole('button', { name: 'Buy now' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/checkout'));
  });

  it('an add refused by the API is shown and does not go to checkout', async () => {
    const u = userEvent.setup();
    routes['POST /cart/items'] = () => json({ error: { code: 'OUT_OF_STOCK', message: 'Only 1 left (you already have 1 in your cart)' } }, 409);
    page('MICA-22');
    await screen.findByText('Only a few left');
    await u.click(screen.getByRole('button', { name: 'Buy now' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Only 1 left (you already have 1 in your cart)');
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('live stock cannot be loaded → says so and nothing can be added (fails closed)', async () => {
    delete routes['GET /products/mica/availability'];
    page();
    expect((await screen.findByRole('alert')).textContent).toBe('Prices and stock are temporarily unavailable. Please try again in a moment.');
    expect((screen.getByRole('button', { name: 'Add to cart' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Buy now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('♡ saves to the wishlist; the WhatsApp button starts the chat with this product', async () => {
    const u = userEvent.setup();
    page();
    await u.click(screen.getByRole('button', { name: 'Save Mica Pigment to wishlist' }));
    expect(screen.getByRole('button', { name: 'Remove Mica Pigment from wishlist' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('link', { name: /WhatsApp/ }).getAttribute('href')).toBe(`https://wa.me/919847012345?text=${encodeURIComponent('Hi ArtQ, I have a question about Mica Pigment')}`);
  });
});

describe('gallery', () => {
  it('thumbnails choose the photo; the video is last; the full-screen viewer zooms, moves with arrows and closes with Esc', async () => {
    const u = userEvent.setup();
    render(<Gallery name="Mica Pigment" images={PRODUCT.images} video={PRODUCT.video} />);
    const thumbs = within(screen.getByRole('list', { name: 'Choose a photo' }));
    expect(thumbs.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Show photo 1', 'Show photo 2', 'Show photo 3', 'Show the video']);
    await u.click(thumbs.getByRole('button', { name: 'Show photo 2' }));
    expect(thumbs.getByRole('button', { name: 'Show photo 2' }).getAttribute('aria-current')).toBe('true');
    await u.click(screen.getByRole('button', { name: 'Open photo 2 of 4 full screen' }));
    const viewer = await screen.findByRole('dialog', { name: 'Mica Pigment · 2 of 4' });
    await u.click(within(viewer).getByRole('button', { name: 'Zoom in' }));
    expect(within(viewer).getByRole('button', { name: 'Zoom out' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    expect(await screen.findByRole('dialog', { name: 'Mica Pigment · 3 of 4' })).toBeTruthy();
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('choosing a variant with its own photo brings that photo forward; no photos → a placeholder that says so', () => {
    const { rerender } = render(<Gallery name="Mica Pigment" images={PRODUCT.images} video={null} />);
    rerender(<Gallery name="Mica Pigment" images={PRODUCT.images} video={null} focus={img(3)} />);
    expect(screen.getByRole('button', { name: 'Show photo 3' }).getAttribute('aria-current')).toBe('true');
    rerender(<Gallery name="Plain" images={[]} video={null} />);
    expect(screen.getByRole('img', { name: 'Plain: no photo yet' })).toBeTruthy();
  });
});

describe('pincode check', () => {
  const answer = (o: object) => () => json({ pincode: '682011', place: { district: 'ERNAKULAM', state: 'Kerala' }, serviceable: true, codAvailable: true, surfaceOnly: false, surfaceAvailable: true, estimatedDays: { min: 4, max: 7 }, reason: null, ...o });
  it('wrong length → message on the field (shared rule); deliverable → place, days, COD; remembered for next time', async () => {
    const u = userEvent.setup();
    routes['GET /pincodes/682011/serviceability'] = answer({});
    const { unmount } = render(<PincodeCheck />);
    await u.type(screen.getByLabelText('Pincode'), '6820');
    await u.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(document.getElementById('pincode-error')!.textContent).toBe('Enter a 6-digit pincode'));
    expect(screen.getByLabelText('Pincode').getAttribute('aria-invalid')).toBe('true');
    await u.clear(screen.getByLabelText('Pincode'));
    await u.type(screen.getByLabelText('Pincode'), '682011{Enter}');
    expect(await screen.findByText('Delivers to Ernakulam, Kerala in 4–7 days. Cash on delivery available.')).toBeTruthy();
    expect(window.localStorage.getItem('aq_pincode')).toBe('682011');
    unmount();
    render(<PincodeCheck />);
    await waitFor(() => expect((screen.getByLabelText('Pincode') as HTMLInputElement).value).toBe('682011'));
  });

  it('not deliverable, unknown pincode, prepaid only, and the API being down each say so', async () => {
    const u = userEvent.setup();
    render(<PincodeCheck />);
    const run = async (o: object | null) => {
      if (o) routes['GET /pincodes/682011/serviceability'] = answer(o); else delete routes['GET /pincodes/682011/serviceability'];
      await u.clear(screen.getByLabelText('Pincode'));
      await u.type(screen.getByLabelText('Pincode'), '682011{Enter}');
    };
    await run({ serviceable: false, reason: 'NOT_SERVICEABLE', estimatedDays: null });
    expect(await screen.findByText('Sorry, we don’t deliver to 682011 yet.')).toBeTruthy();
    await run({ serviceable: false, reason: 'UNKNOWN_PINCODE', place: null });
    expect(await screen.findByText('We couldn’t find pincode 682011. Please check the number.')).toBeTruthy();
    await run({ codAvailable: false });
    expect(await screen.findByText(/Prepaid only \(no cash on delivery here\)\./)).toBeTruthy();
    expect(screen.queryByText(/travel by road only/)).toBeNull();
    await run({ surfaceAvailable: false });
    expect(await screen.findByText('Resin and other liquids travel by road only, so they can’t be delivered here.')).toBeTruthy();
    await run(null);
    expect((await screen.findByRole('alert')).textContent).toBe('We could not reach the store. Check your connection and try again.');
  });
});

describe('recently viewed', () => {
  it('shows the other products viewed before (newest first) and records this one first', async () => {
    window.localStorage.setItem('aq_recent', JSON.stringify([3, 7, 5]));
    routes['GET /products/by-ids?ids=3,5'] = () => json({ data: [{ id: 3, slug: 'p-3', name: 'Viewed Three', image: null, hoverImage: null, fromPrice: 100, maxPrice: 100, mrp: null, discountPercent: null, inStock: true, isNew: false, isTrending: false, variantCount: 2, defaultVariantId: null, type: { slug: 't', name: 'T' } }] });
    render(<RecentlyViewed productId={7} />);
    expect(await screen.findByRole('heading', { name: 'Recently viewed' })).toBeTruthy();
    expect(screen.getByText('Viewed Three')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('aq_recent')!)).toEqual([7, 3, 5]);
  });

  it('nothing viewed before → no section, no request', () => {
    render(<RecentlyViewed productId={7} />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(calls.some((c) => c.path.startsWith('/products/by-ids'))).toBe(false);
    act(() => {});
  });
});

describe('JSON-LD', () => {
  it('several sizes → AggregateOffer (rupees), stock summary, breadcrumbs; one size → Offer with SKU', () => {
    const [p, crumbs] = productJsonLd(PRODUCT) as [Record<string, unknown>, Record<string, unknown>];
    expect(p).toMatchObject({ '@type': 'Product', name: 'Mica Pigment', description: 'Fine mica.', brand: { name: 'ArtQ' }, image: ['https://cdn.test/1.webp', 'https://cdn.test/2.webp', 'https://cdn.test/3.webp'],
      offers: { '@type': 'AggregateOffer', lowPrice: '190.00', highPrice: '490.00', offerCount: 3, priceCurrency: 'INR', availability: 'https://schema.org/InStock' } });
    expect((crumbs.itemListElement as { name: string }[]).map((c) => c.name)).toEqual(['Home', 'Pigments', 'Mica Powder', 'Mica Pigment']);
    const [one] = productJsonLd({ ...PRODUCT, variants: [PRODUCT.variants[0]!], inStock: false }) as [Record<string, unknown>];
    expect(one).toMatchObject({ sku: 'MICA-21', offers: { '@type': 'Offer', price: '190.00', sku: 'MICA-21', availability: 'https://schema.org/OutOfStock' } });
  });
  it('text from the catalogue cannot close the script tag', () => {
    expect(jsonLdScript({ name: '</script><script>alert(1)</script>' })).not.toContain('</script>');
  });
});
