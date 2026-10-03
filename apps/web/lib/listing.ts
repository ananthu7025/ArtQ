// Listing URL state (product.md §5.2: filters live in the query string, e.g. /shop?type=pigments&size=20+gm&sort=price_asc&page=2).
// The storefront URL uses whole rupees (min/max); the API uses paise. Unknown or malformed values (tracking tags, a
// hand-edited sort) are dropped, never sent to the API, so a shared link can always be opened.
import { LISTING_MAX_LIMIT, LISTING_PAGE_SIZE, LISTING_SORTS, type ListingSort } from '@artq/shared';

export type ListingState = {
  type: string[]; category: string[]; technique: string[]; size: string[]; color: string[]; thickness: string[];
  min: number | null; max: number | null; inStock: boolean; sale: boolean; q: string; sort: ListingSort | null; page: number;
};
/** What a page fixes (a type page always filters by its type, New Arrivals by the flag…). */
export type ListingFixed = { type?: string; category?: string; technique?: string; isNew?: boolean; isTrending?: boolean };
export type SearchParams = Record<string, string | string[] | undefined>;

const LISTS = ['type', 'category', 'technique', 'size', 'color', 'thickness'] as const;
export const SORT_LABELS: Record<ListingSort, string> = {
  featured: 'Featured', newest: 'Newest', price_asc: 'Price: low to high', price_desc: 'Price: high to low', name_asc: 'Name', best_selling: 'Best selling', relevance: 'Relevance',
};

const all = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const rupees = (v: string | string[] | undefined) => { const s = all(v)[0]; return s !== undefined && /^\d{1,6}$/.test(s) ? Number(s) : null; };

export function parseListing(sp: SearchParams): ListingState {
  const lists = Object.fromEntries(LISTS.map((k) => [k, [...new Set(all(sp[k]).map((x) => x.trim()).filter((x) => x && x.length <= 80))].slice(0, 20)])) as Pick<ListingState, (typeof LISTS)[number]>;
  let min = rupees(sp.min), max = rupees(sp.max);
  if (min !== null && max !== null && min > max) { min = null; max = null; }
  const q = (all(sp.q)[0] ?? '').trim().slice(0, 100);
  const sortRaw = all(sp.sort)[0];
  const sort = LISTING_SORTS.includes(sortRaw as ListingSort) && (sortRaw !== 'relevance' || q) ? (sortRaw as ListingSort) : null;
  const pageRaw = Number(all(sp.page)[0]);
  return { ...lists, min, max, inStock: all(sp.inStock)[0] === '1', sale: all(sp.sale)[0] === '1', q, sort, page: Number.isInteger(pageRaw) && pageRaw >= 1 && pageRaw <= 200 ? pageRaw : 1 };
}

/** The storefront query string for a state (stable order, defaults left out). */
export function listingSearch(s: ListingState): string {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  for (const k of LISTS) for (const v of s[k]) p.append(k, v);
  if (s.min !== null) p.set('min', String(s.min));
  if (s.max !== null) p.set('max', String(s.max));
  if (s.inStock) p.set('inStock', '1');
  if (s.sale) p.set('sale', '1');
  if (s.sort) p.set('sort', s.sort);
  if (s.page > 1) p.set('page', String(s.page));
  const out = p.toString();
  return out ? `?${out}` : '';
}

/** The API path for a state plus what the page fixes. `pages` > 1 loads pages 1…n at once (a reload of ?page=n). */
export function apiListPath(s: ListingState, fixed: ListingFixed, opts: { page?: number; pages?: number } = {}): string {
  const p = new URLSearchParams();
  for (const k of LISTS) {
    const values = k === 'type' || k === 'category' || k === 'technique' ? (fixed[k] ? [fixed[k]!] : s[k]) : s[k];
    for (const v of values) p.append(k, v);
  }
  if (s.q) p.set('q', s.q);
  if (s.min !== null) p.set('minPrice', String(s.min * 100));
  if (s.max !== null) p.set('maxPrice', String(s.max * 100));
  if (s.inStock) p.set('inStock', '1');
  if (s.sale) p.set('sale', '1');
  if (fixed.isNew) p.set('isNew', '1');
  if (fixed.isTrending) p.set('isTrending', '1');
  if (s.sort) p.set('sort', s.sort);
  const pages = Math.min(opts.pages ?? 1, Math.floor(LISTING_MAX_LIMIT / LISTING_PAGE_SIZE));
  if (pages > 1) p.set('limit', String(pages * LISTING_PAGE_SIZE));
  else { p.set('limit', String(LISTING_PAGE_SIZE)); if ((opts.page ?? 1) > 1) p.set('page', String(opts.page)); }
  return `/products?${p.toString()}`;
}

/** How many filters the shopper chose (the "Filters (n)" button). */
export function activeCount(s: ListingState): number {
  return LISTS.reduce((n, k) => n + s[k].length, 0) + (s.min !== null || s.max !== null ? 1 : 0) + (s.inStock ? 1 : 0) + (s.sale ? 1 : 0);
}

export const EMPTY_STATE: ListingState = { type: [], category: [], technique: [], size: [], color: [], thickness: [], min: null, max: null, inStock: false, sale: false, q: '', sort: null, page: 1 };
