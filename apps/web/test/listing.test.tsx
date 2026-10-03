// Task 3.5: listing URL state and the listing view (product.md §5.2).
import type { ProductCard, ProductList } from '@artq/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListingView } from '../components/listing/ListingView';
import { API_URL } from '../lib/api';
import { activeCount, apiListPath, EMPTY_STATE, listingSearch, parseListing } from '../lib/listing';
import { nav } from './setup';

describe('listing URL state', () => {
  it('parses lists (repeated params, trimmed, de-duplicated), rupees, flags, sort and page; drops what it does not know', () => {
    const s = parseListing({ type: 'pigments', size: ['10 gm', ' 10 gm ', '50 gm'], color: 'Gold', min: '200', max: '500', inStock: '1', sale: 'true', sort: 'price_asc', page: '3', utm_source: 'insta', fbclid: 'x' });
    expect(s).toEqual({ ...EMPTY_STATE, type: ['pigments'], size: ['10 gm', '50 gm'], color: ['Gold'], min: 200, max: 500, inStock: true, sort: 'price_asc', page: 3 });
    expect(activeCount(s)).toBe(6);
  });

  it('bad values are ignored rather than breaking the page', () => {
    expect(parseListing({ min: '-5', max: 'abc', sort: 'cheapest', page: '0' })).toEqual(EMPTY_STATE);
    expect(parseListing({ min: '500', max: '100' })).toMatchObject({ min: null, max: null });   // min above max → neither
    expect(parseListing({ sort: 'relevance' }).sort).toBeNull();                                   // relevance needs a search
    expect(parseListing({ sort: 'relevance', q: 'mica' }).sort).toBe('relevance');
    expect(parseListing({ page: '201' }).page).toBe(1);
    expect(parseListing({ size: Array.from({ length: 30 }, (_, i) => `s${i}`) }).size).toHaveLength(20);
    expect(parseListing({ q: 'x'.repeat(150) }).q).toHaveLength(100);
  });

  it('round-trips to a stable query string; defaults (page 1, no sort) are left out', () => {
    const s = parseListing({ color: ['Gold', 'Silver'], min: '200', sort: 'newest', page: '2' });
    expect(listingSearch(s)).toBe('?color=Gold&color=Silver&min=200&sort=newest&page=2');
    expect(listingSearch(EMPTY_STATE)).toBe('');
    expect(parseListing(Object.fromEntries(new URLSearchParams('color=Gold&color=Silver&min=200').entries()))).toBeTruthy();
  });

  it('API path: rupees → paise, the page\'s fixed filter wins, flags added, pages 1…n loaded at once (max 4)', () => {
    const s = parseListing({ type: 'frames', min: '200', max: '500', inStock: '1' });
    expect(apiListPath(s, { type: 'pigments' })).toBe('/products?type=pigments&minPrice=20000&maxPrice=50000&inStock=1&limit=24');
    expect(apiListPath(EMPTY_STATE, { isNew: true }, { page: 3 })).toBe('/products?isNew=1&limit=24&page=3');
    expect(apiListPath(EMPTY_STATE, { isTrending: true }, { pages: 2 })).toBe('/products?isTrending=1&limit=48');
    expect(apiListPath(EMPTY_STATE, {}, { pages: 9 })).toBe('/products?limit=96');
  });
});

const card = (id: number): ProductCard => ({ id, slug: `p-${id}`, name: `Product ${id}`, image: null, hoverImage: null, fromPrice: 10_000, maxPrice: 10_000, mrp: null, discountPercent: null, inStock: true, isNew: false, isTrending: false, variantCount: 2, defaultVariantId: null, type: { slug: 'pigments', name: 'Pigments' } });
const LIST = (n: number, total: number): ProductList => ({
  data: Array.from({ length: n }, (_, i) => card(i + 1)), meta: { page: 1, limit: 24, total, totalPages: Math.ceil(total / 24) },
  facets: {
    types: [{ value: 'pigments', label: 'Pigments', count: 30 }], categories: [{ value: 'mica', label: 'Mica Powder', count: 12 }], techniques: [],
    sizes: Array.from({ length: 10 }, (_, i) => ({ value: `${(i + 1) * 10} gm`, label: `${(i + 1) * 10} gm`, count: i + 1 })),
    colors: [{ value: 'Gold', label: 'Gold', count: 4, hex: '#D4AF37' }], thicknesses: [], price: { min: 9_000, max: 5_45_000 },
  },
});
const axeClean = async (el: Element) => expect((await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
const view = (list: ProductList | null, sp: Record<string, string | string[]> = {}, hide: ('type' | 'category')[] = []) => {
  nav.pathname = '/shop';
  return render(<ListingView list={list} state={parseListing(sp)} fixed={{}} hide={hide} />);
};
const aside = () => within(screen.getByRole('complementary', { name: 'Filters' }));

describe('ListingView', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); window.history.replaceState(null, '', '/shop'); });
  afterEach(() => vi.unstubAllGlobals());

  it('count, cards, filter groups with counts (first 8 sizes, then "Show all"), sort; passes axe', async () => {
    const u = userEvent.setup();
    const { container } = view(LIST(24, 30));
    expect(screen.getByRole('status').textContent).toBe('30 products');
    expect(screen.getAllByRole('article')).toHaveLength(24);
    expect(aside().getByRole('group', { name: 'Product type' })).toBeTruthy();
    expect(aside().getByRole('checkbox', { name: 'Gold, 4 products' })).toBeTruthy();
    const sizes = aside().getByRole('group', { name: 'Size' });
    expect(within(sizes).getAllByRole('checkbox')).toHaveLength(8);
    await u.click(within(sizes).getByRole('button', { name: /Show all 10/ }));
    expect(within(sizes).getAllByRole('checkbox')).toHaveLength(10);
    expect((screen.getByRole('combobox', { name: 'Sort by' }) as HTMLSelectElement).value).toBe('featured');
    expect(within(screen.getByRole('combobox', { name: 'Sort by' })).queryByRole('option', { name: 'Relevance' })).toBeNull();
    await axeClean(container);
  });

  it('ticking a filter, choosing a sort and toggling In stock each navigate to the new URL (page reset, scroll kept)', async () => {
    const u = userEvent.setup();
    view(LIST(24, 30), { size: '10 gm', page: '2' });
    await u.click(aside().getByRole('checkbox', { name: /^Gold/ }));
    expect(nav.push).toHaveBeenLastCalledWith('/shop?size=10+gm&color=Gold', { scroll: false });
    await u.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'price_asc');
    expect(nav.push).toHaveBeenLastCalledWith('/shop?size=10+gm&sort=price_asc', { scroll: false });
    await u.click(aside().getByRole('checkbox', { name: 'In stock only' }));
    expect(nav.push).toHaveBeenLastCalledWith('/shop?size=10+gm&inStock=1', { scroll: false });
    await u.click(aside().getByRole('checkbox', { name: /^10 gm/ }));                    // untick
    expect(nav.push).toHaveBeenLastCalledWith('/shop', { scroll: false });
  });

  it('active-filter chips use names (not slugs) and remove one at a time; Clear all keeps the sort', async () => {
    const u = userEvent.setup();
    view(LIST(5, 5), { category: 'mica', color: 'Gold', min: '200', inStock: '1', sort: 'newest' });
    const chips = within(screen.getByRole('list', { name: 'Active filters' }));
    expect(chips.getAllByRole('button').map((b) => b.textContent)).toEqual(['Mica Powder, remove this filter', 'Gold, remove this filter', '₹200 – any, remove this filter', 'In stock, remove this filter', 'Clear all']);
    await u.click(chips.getByRole('button', { name: /^Gold/ }));
    expect(nav.push).toHaveBeenLastCalledWith('/shop?category=mica&min=200&inStock=1&sort=newest', { scroll: false });
    await u.click(chips.getByRole('button', { name: 'Clear all' }));
    expect(nav.push).toHaveBeenLastCalledWith('/shop?sort=newest', { scroll: false });
  });

  it('price (shared rule): max below min → message under the field, no navigation; letters → message; valid → ?min&max in rupees', async () => {
    const u = userEvent.setup();
    view(LIST(5, 5));
    const form = aside();
    await u.type(form.getByLabelText('Minimum'), '500');
    await u.type(form.getByLabelText('Maximum'), '100');
    await u.click(form.getByRole('button', { name: 'Apply price' }));
    await waitFor(() => {
      const max = form.getByLabelText('Maximum');
      expect(max.getAttribute('aria-invalid')).toBe('true');
      expect(document.getElementById(`${max.id}-error`)!.textContent).toBe('The maximum must be at least the minimum');
    });
    expect(nav.push).not.toHaveBeenCalled();
    await u.clear(form.getByLabelText('Maximum'));
    await u.type(form.getByLabelText('Maximum'), 'abc');
    await u.click(form.getByRole('button', { name: 'Apply price' }));
    await waitFor(() => expect(form.getByLabelText('Maximum').getAttribute('aria-invalid')).toBe('true'));
    await u.clear(form.getByLabelText('Maximum'));
    await u.type(form.getByLabelText('Maximum'), '500');
    await u.click(form.getByRole('button', { name: 'Apply price' }));
    expect(nav.push).toHaveBeenLastCalledWith('/shop?min=500&max=500', { scroll: false });   // exactly equal is allowed
  });

  it('Load more appends the next page with the same filters and records ?page= in the address', async () => {
    const u = userEvent.setup();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...LIST(6, 30), data: Array.from({ length: 6 }, (_, i) => card(100 + i)) }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    view(LIST(24, 30), { color: 'Gold' });
    expect(screen.getByText('Showing 24 of 30')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(30));
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`${API_URL}/products?color=Gold&limit=24&page=2`);
    expect(window.location.search).toBe('?color=Gold&page=2');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();               // all 30 shown
  });

  it('Load more failing says so and keeps what is shown', async () => {
    const u = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    view(LIST(24, 30));
    await u.click(screen.getByRole('button', { name: 'Load more' }));
    expect((await screen.findByRole('alert')).textContent).toBe('We couldn’t load more products. Please try again.');
    expect(screen.getAllByRole('article')).toHaveLength(24);
  });

  it('empty: with filters → "Clear filters"; without → a friendly note; API down → retry', async () => {
    const u = userEvent.setup();
    const { unmount } = view(LIST(0, 0), { color: 'Gold' });
    expect(screen.getByText('No products match these filters')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(nav.push).toHaveBeenLastCalledWith('/shop', { scroll: false });
    unmount();
    const empty = view(LIST(0, 0));
    expect(screen.getByText('No products match here yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    empty.unmount();
    view(null);
    expect(screen.getByRole('alert').textContent).toBe('We couldn’t load products right now. Please try again in a moment.');
    await u.click(screen.getByRole('button', { name: 'Try again' }));
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('phones: "Filters (n)" opens a sheet with the same filters and a "Show N products" button', async () => {
    const u = userEvent.setup();
    view(LIST(5, 5), { color: 'Gold', inStock: '1' });
    await u.click(screen.getByRole('button', { name: 'Filters, 2 chosen' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(sheet).getByRole('checkbox', { name: /^Gold/ })).toHaveProperty('checked', true);
    await u.click(within(sheet).getByRole('button', { name: 'Show 5 products' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a page that fixes its type/category hides those filter groups', () => {
    view(LIST(5, 5), {}, ['type', 'category']);
    expect(aside().queryByRole('group', { name: 'Product type' })).toBeNull();
    expect(aside().queryByRole('group', { name: 'Category' })).toBeNull();
    expect(aside().getByRole('group', { name: 'Size' })).toBeTruthy();
  });

  it('with a search, Relevance is offered and is the default', () => {
    view(LIST(5, 5), { q: 'mica' });
    const sort = screen.getByRole('combobox', { name: 'Sort by' }) as HTMLSelectElement;
    expect(sort.value).toBe('relevance');
    act(() => {});
  });
});
