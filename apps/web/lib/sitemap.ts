// The sitemap's contents (task 6.4), apart from the Next.js file so it can be tested: the fixed pages, then everything
// the API says a visitor can open, minus the addresses the owner hid from search. If the API is down the fixed pages
// are still listed (a sitemap is never empty).
import type { SitemapEntries } from '@artq/shared';
import type { MetadataRoute } from 'next';
import { publicGet } from './api';
import { SITE_URL } from './seo';

const FIXED: { path: string; priority: number; changeFrequency: 'daily' | 'weekly' | 'monthly' }[] = [
  { path: '/', priority: 1, changeFrequency: 'daily' },
  { path: '/shop', priority: 0.9, changeFrequency: 'daily' },
  { path: '/new-arrivals', priority: 0.8, changeFrequency: 'daily' },
  { path: '/trending', priority: 0.7, changeFrequency: 'daily' },
  { path: '/faqs', priority: 0.4, changeFrequency: 'monthly' },
  { path: '/contact', priority: 0.4, changeFrequency: 'monthly' },
  { path: '/custom-work', priority: 0.5, changeFrequency: 'monthly' },
];

export async function buildSitemap(fetchImpl?: Parameters<typeof publicGet>[1]): Promise<MetadataRoute.Sitemap> {
  const url = (path: string) => (path === '/' ? SITE_URL : `${SITE_URL}${path}`);
  const fixed: MetadataRoute.Sitemap = FIXED.map((f) => ({ url: url(f.path), changeFrequency: f.changeFrequency, priority: f.priority }));
  let e: SitemapEntries;
  try { e = await publicGet<SitemapEntries>('/seo/sitemap-entries', fetchImpl, 10_000); } catch { return fixed; }
  const hidden = new Set(e.noindex);
  const list = (prefix: string, rows: { slug: string; updatedAt: string }[], priority: number, extra: (i: number) => object = () => ({})) =>
    rows.map((r, i) => ({ path: `${prefix}/${r.slug}`, item: { url: url(`${prefix}/${r.slug}`), lastModified: r.updatedAt, changeFrequency: 'weekly' as const, priority, ...extra(i) } }));
  const all = [
    ...FIXED.map((f, i) => ({ path: f.path, item: fixed[i]! })),
    ...list('/type', e.types, 0.8), ...list('/category', e.categories, 0.7), ...list('/technique', e.techniques, 0.6),
    ...list('/product', e.products, 0.6, (i) => (e.products[i]!.image ? { images: [e.products[i]!.image!] } : {})),
    ...list('', e.pages, 0.3),
  ];
  return all.filter((x) => !hidden.has(x.path)).map((x) => x.item);
}
