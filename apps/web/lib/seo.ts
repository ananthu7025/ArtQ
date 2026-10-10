// Search-engine data: JSON-LD (task 3.6 product pages; 6.4 the site, listings, breadcrumbs) and page metadata with the
// owner's overrides from the admin (task 6.4: title, description, canonical, "hide from search"). Stock here is the
// cached yes/no summary; exact stock is never published.
import type { ProductDetail, PublicSettings, SeoResolve } from '@artq/shared';
import type { Metadata } from 'next';
import { publicGet } from './api';

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const rupees = (paise: number) => (paise / 100).toFixed(2);
export const plainText = (html: string | null) => (html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();

export function productJsonLd(p: ProductDetail): object[] {
  const url = `${SITE_URL}/product/${p.slug}`;
  const description = plainText(p.description).slice(0, 5000) || p.shortDescription || undefined;
  const availability = `https://schema.org/${p.inStock ? 'InStock' : 'OutOfStock'}`;
  const offers = p.variants.length === 1
    ? { '@type': 'Offer', price: rupees(p.variants[0]!.price), priceCurrency: 'INR', availability, url, sku: p.variants[0]!.sku, itemCondition: 'https://schema.org/NewCondition' }
    : { '@type': 'AggregateOffer', lowPrice: rupees(p.fromPrice), highPrice: rupees(p.maxPrice), offerCount: p.variants.length, priceCurrency: 'INR', availability, url };
  const crumbs = [{ name: 'Home', item: SITE_URL }, { name: p.type.name, item: `${SITE_URL}/type/${p.type.slug}` },
    ...(p.category ? [{ name: p.category.name, item: `${SITE_URL}/category/${p.category.slug}` }] : []), { name: p.name, item: url }];
  return [
    {
      '@context': 'https://schema.org', '@type': 'Product', name: p.name, url, brand: { '@type': 'Brand', name: 'ArtQ' },
      ...(description ? { description } : {}), ...(p.images.length ? { image: p.images.map((i) => i.url) } : {}),
      ...(p.variants.length === 1 ? { sku: p.variants[0]!.sku } : {}), category: p.category?.name ?? p.type.name, offers,
    },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })) },
  ];
}

/** JSON for a <script type="application/ld+json">: "<" escaped so text from the catalogue can never close the tag. */
export const jsonLdScript = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

/** Staging and preview sites are never indexed (architecture.md §15: staging is noindex). */
export const SITE_NOINDEX = process.env.NEXT_PUBLIC_SEO_NOINDEX === '1';
export const SITE_TITLE = 'ArtQ: Wood Moulds & Resins';
export const SITE_DESCRIPTION = 'Resin art supplies, wooden frames, moulds and pigments, shipped all over India.';

type Fetch = Parameters<typeof publicGet>[1];
/** The admin's override for an address, or null (also when the API is slow or down: the page's own metadata stands). */
export async function loadSeoOverride(path: string, fetchImpl?: Fetch): Promise<SeoResolve['seo']> {
  try { return (await publicGet<SeoResolve>(`/seo/resolve?path=${encodeURIComponent(path)}`, fetchImpl, 1500)).seo ?? null; } catch { return null; }
}

/**
 * A public page's metadata: its canonical address (no filters or page numbers), Open Graph for sharing, and the admin's
 * override on top (title, description, canonical, hidden from search).
 */
export async function withSeo(path: string, base: Metadata & { title?: string }, fetchImpl?: Fetch): Promise<Metadata> {
  const o = await loadSeoOverride(path, fetchImpl);
  const title = o?.metaTitle ?? base.title;
  const description = o?.metaDescription ?? base.description ?? undefined;
  const ogTitle = title ?? SITE_TITLE;
  const canonical = o?.canonical ?? path;
  return {
    ...base,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    alternates: { ...base.alternates, canonical },
    openGraph: { siteName: 'ArtQ', locale: 'en_IN', type: 'website', url: canonical, title: ogTitle, description: description ?? SITE_DESCRIPTION, ...base.openGraph },
    ...(o?.noindex ? { robots: { index: false, follow: true } } : {}),
  };
}

const crumbList = (crumbs: { name: string; path: string }[]) => ({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.path === '/' ? SITE_URL : `${SITE_URL}${c.path}` })),
});
/** BreadcrumbList for a listing (Home first). */
export const breadcrumbJsonLd = (crumbs: { name: string; path: string }[]) => crumbList([{ name: 'Home', path: '/' }, ...crumbs]);

/** The home page: who sells here, and the site search (Google's sitelinks search box). */
export function siteJsonLd(settings: Pick<PublicSettings, 'store' | 'social'>): object[] {
  const { store, social } = settings;
  const sameAs = [social.instagram, social.facebook, social.youtube].filter((u): u is string => !!u);
  return [
    { '@context': 'https://schema.org', '@type': 'Organization', name: store.name, url: SITE_URL,
      ...(store.email ? { email: store.email } : {}), ...(store.phone ? { telephone: store.phone } : {}), ...(sameAs.length ? { sameAs } : {}) },
    { '@context': 'https://schema.org', '@type': 'WebSite', name: store.name, url: SITE_URL,
      potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/search?q={search_term_string}` }, 'query-input': 'required name=search_term_string' } },
  ];
}
