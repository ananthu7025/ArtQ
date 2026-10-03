// Public cache allow-list (architecture.md §6.1). Only these GETs may be stored by shared caches (CDN, Next.js ISR);
// every other response is `private, no-store`. The API applies it to every response (middleware/cachePolicy.ts) and the
// storefront refuses to fetch anything else on the server, so a personal response can never end up in a cached page.
export const PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=60';
export const NO_STORE = 'private, no-store';

/** Paths relative to `/v1`. `/products/:slug/availability` is deliberately not matched (live stock, never cached);
 * `/products/:slug/related` is (public cards, task 3.6). */
export const PUBLIC_CACHE_PATTERNS: readonly RegExp[] = [
  /^\/home$/, /^\/navigation$/, /^\/settings\/public$/,
  /^\/types(\/[^/]+)*$/, /^\/categories(\/[^/]+)*$/, /^\/techniques(\/[^/]+)*$/,
  /^\/products$/, /^\/products\/[^/]+$/, /^\/products\/[^/]+\/related$/,
  /^\/states$/, /^\/pages\/[^/]+$/, /^\/faqs$/, /^\/testimonials$/, /^\/reels$/, /^\/seo(\/[^/]+)+$/,
];

/** True when a GET of `path` (relative to /v1, query string allowed) may be publicly cached. Case-insensitive like Express routing; one trailing slash is ignored. */
export function isPublicCacheable(path: string): boolean {
  let p = path.split('?')[0]!.split('#')[0]!.toLowerCase();
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return PUBLIC_CACHE_PATTERNS.some((re) => re.test(p));
}
