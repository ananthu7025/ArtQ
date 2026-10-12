// SEO (task 6.4; api.md §3.1 "/seo/*", §4.10 "SEO"). Redirects for old addresses (e.g. the previous shop's URLs) and
// per-address overrides of the title, description, canonical and indexing. Renamed products, types, categories and
// techniques already move by themselves (slug_redirects), so their addresses are not redirected here. Shared by the
// API, the admin forms and the storefront's proxy (validation rule).
import { z } from 'zod';

/** Addresses the shop itself serves (or that move by themselves): never redirected by hand, and the storefront proxy
 *  never looks them up. Keep in step with the `matcher` in apps/web/proxy.ts (a test checks). */
export const SEO_RESERVED_PREFIXES = [
  '/_next', '/api', '/account', '/cart', '/checkout', '/login', '/signup', '/forgot-password', '/reset-password', '/set-password',
  '/track', '/newsletter', '/wishlist', '/search', '/product', '/type', '/category', '/technique', '/shop', '/new-arrivals', '/trending',
] as const;
export const isReservedSeoPath = (p: string) => p === '/' || SEO_RESERVED_PREFIXES.some((x) => p === x || p.startsWith(`${x}/`));

/** One spelling per address: lower case, no repeated or trailing slash, no query or fragment. */
export function normalizeSeoPath(p: string): string {
  const path = p.split(/[?#]/)[0]!.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

const PATH_CHARS = /^\/[A-Za-z0-9\-._~%/]*$/;
const pathMsg = 'Use an address on this site starting with /, like /old-page (no domain, ? or #)';
/** An address on this site (no query): normalised. */
export const seoPathField = z.string({ error: 'Enter an address' }).trim().min(1, 'Enter an address').max(300, 'Use at most 300 characters')
  .regex(PATH_CHARS, pathMsg).transform(normalizeSeoPath);
/** Where a redirect goes: a path on this site, a query allowed (/shop?type=resins); never another site (`//host`). */
export const redirectTargetField = z.string({ error: 'Enter where it should go' }).trim().min(1, 'Enter where it should go').max(300, 'Use at most 300 characters')
  .regex(/^\/(?![/\\])[^\s#\\]*$/, 'Use an address on this site starting with /, like /shop or /shop?type=resins');

const pathOf = (to: string) => normalizeSeoPath(to);

export const redirectBody = z.strictObject({
  fromPath: seoPathField.refine((p) => !isReservedSeoPath(p), 'This address is served by the shop (renamed products and categories already redirect by themselves)'),
  toPath: redirectTargetField,
  statusCode: z.union([z.literal(301), z.literal(302)], { error: 'Choose permanent (301) or temporary (302)' }).default(301),
}).superRefine((b, ctx) => {
  if (pathOf(b.toPath) === b.fromPath) ctx.addIssue({ code: 'custom', path: ['toPath'], message: 'It can’t redirect to itself' });
});
export type RedirectInput = z.input<typeof redirectBody>;
export type RedirectRow = { id: number; fromPath: string; toPath: string; statusCode: 301 | 302 };

const optText = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`).transform((v) => v || null).nullable().default(null);
export const SEO_TITLE_MAX = 160;
export const SEO_DESCRIPTION_MAX = 320;
export const seoOverrideBody = z.strictObject({
  path: seoPathField,
  metaTitle: optText(SEO_TITLE_MAX),
  metaDescription: optText(SEO_DESCRIPTION_MAX),
  canonical: z.string().trim().max(500, 'Use at most 500 characters')
    .refine((v) => v === '' || /^\/(?![/\\])[^\s#\\]*$/.test(v) || /^https:\/\/[^\s/?#]+(\/[^\s#]*)?$/.test(v), 'Use an address starting with / or https://')
    .transform((v) => v || null).nullable().default(null),
  noindex: z.boolean().default(false),
}).superRefine((b, ctx) => {
  if (!b.metaTitle && !b.metaDescription && !b.canonical && !b.noindex) ctx.addIssue({ code: 'custom', path: ['metaTitle'], message: 'Set at least one of title, description, canonical or “hide from search”' });
});
export type SeoOverrideInput = z.input<typeof seoOverrideBody>;
export type SeoOverrideRow = { id: number; path: string; metaTitle: string | null; metaDescription: string | null; canonical: string | null; noindex: boolean };

export const seoListQuery = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /seo/resolve?path= (the storefront proxy and page metadata). */
export const seoResolveQuery = z.strictObject({ path: z.string().max(600).regex(/^\//, 'A path starting with /').transform(normalizeSeoPath) });
export type SeoResolve = {
  redirect: { to: string; status: 301 | 302 } | null;
  seo: { metaTitle: string | null; metaDescription: string | null; canonical: string | null; noindex: boolean } | null;
};

/** GET /seo/sitemap-entries: everything a visitor can open, with when it last changed; `noindex` paths to leave out. */
export type SitemapEntries = {
  products: { slug: string; updatedAt: string; image: string | null }[];
  types: { slug: string; updatedAt: string }[];
  categories: { slug: string; updatedAt: string }[];
  techniques: { slug: string; updatedAt: string }[];
  pages: { slug: string; updatedAt: string }[];
  noindex: string[];
};
