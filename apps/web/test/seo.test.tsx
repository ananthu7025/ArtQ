// Task 6.4: SEO in the storefront. Page metadata (canonical without filters, Open Graph, the admin's override on top,
// the API down leaves the page's own), the sitemap (fixed pages + what the API lists, hidden addresses left out,
// product images; the API down still lists the fixed pages), robots (private paths; staging refuses all), the redirect
// lookup behind proxy.ts (301/302, query kept, never another site, remembered a minute, failures not remembered) and
// its matcher kept in step with the shared reserved list, and the JSON-LD on home and listing pages.
import { SEO_RESERVED_PREFIXES, type SitemapEntries, type TaxonomyPage } from '@artq/shared';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMetadata as typeMetadata } from '../app/type/[slug]/page';
import { TaxonomyListing } from '../lib/taxonomy-page';
import { generateMetadata as shopMetadata } from '../app/shop/page';
import { config } from '../proxy';
import { API_URL } from '../lib/api';
import { clearRedirectMemo, redirectFor } from '../lib/redirects';
import { buildRobots } from '../lib/robots';
import { breadcrumbJsonLd, siteJsonLd, SITE_URL, withSeo } from '../lib/seo';
import { buildSitemap } from '../lib/sitemap';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let routes: Record<string, () => Response>;
let calls: string[];
beforeEach(() => {
  calls = []; routes = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.slice(API_URL.length);
    calls.push(path);
    const r = routes[path];
    if (!r) throw new TypeError('Failed to fetch');
    return r();
  }));
});
afterEach(() => { vi.unstubAllGlobals(); clearRedirectMemo(); });
const resolveKey = (p: string) => `/seo/resolve?path=${encodeURIComponent(p)}`;
const none = { redirect: null, seo: null };

describe('page metadata', () => {
  it('no override: canonical is the bare path, Open Graph filled in', async () => {
    routes[resolveKey('/shop')] = () => json(none);
    expect(await shopMetadata()).toMatchObject({
      title: 'Shop all', description: 'Resin art supplies, wooden frames, moulds and pigments from ArtQ.', alternates: { canonical: '/shop' },
      openGraph: { siteName: 'ArtQ', locale: 'en_IN', url: '/shop', title: 'Shop all' },
    });
  });

  it('the admin’s override wins: title, description, canonical, hidden from search', async () => {
    routes[resolveKey('/shop')] = () => json({ redirect: null, seo: { metaTitle: 'Resin art supplies online', metaDescription: 'Everything for resin art.', canonical: 'https://artq.in/shop', noindex: true } });
    const m = await shopMetadata();
    expect(m).toMatchObject({ title: 'Resin art supplies online', description: 'Everything for resin art.', alternates: { canonical: 'https://artq.in/shop' }, robots: { index: false, follow: true } });
    expect(m.openGraph).toMatchObject({ title: 'Resin art supplies online', url: 'https://artq.in/shop' });
  });

  it('the API down or slow: the page’s own metadata stands', async () => {
    expect(await withSeo('/faqs', { title: 'FAQs' })).toMatchObject({ title: 'FAQs', alternates: { canonical: '/faqs' } });
    routes[resolveKey('/faqs')] = () => json({ error: { code: 'INTERNAL' } }, 500);
    const m = await withSeo('/faqs', { title: 'FAQs' });
    expect(m.robots).toBeUndefined();
    expect(m.alternates).toEqual({ canonical: '/faqs' });
  });
});

describe('taxonomy page', () => {
  const type: TaxonomyPage = { kind: 'type', name: 'Resins', slug: 'resins', description: 'Epoxy and UV resins.', banner: { id: 1, url: 'https://cdn.test/b.webp', width: 1600, height: 500, alt: 'Resins', placeholder: null, srcset: { webp: '' } }, metaTitle: null, metaDescription: null, parent: null, children: [] };
  it('metadata with the banner for sharing; BreadcrumbList on the page', async () => {
    routes['/types/resins'] = () => json(type);
    routes[resolveKey('/type/resins')] = () => json(none);
    expect(await typeMetadata({ params: Promise.resolve({ slug: 'resins' }), searchParams: Promise.resolve({}) })).toMatchObject({
      title: 'Resins', description: 'Epoxy and UV resins.', alternates: { canonical: '/type/resins' }, openGraph: { images: [{ url: 'https://cdn.test/b.webp', width: 1600, height: 500 }] },
    });
    // The listing itself is an async server component (tested in listing.test); render the page's JSON-LD part.
    const page = await TaxonomyListing({ kind: 'type', slug: 'resins', searchParams: { size: '10 gm', page: '2' } }) as ReactElement<{ children: ReactNode[] }>;
    const { container } = render(<>{page.props.children[0]}</>);
    const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.textContent!);
    expect(ld).toEqual(breadcrumbJsonLd([{ name: 'Shop all', path: '/shop' }, { name: 'Resins', path: '/type/resins' }]));
    expect(ld.itemListElement.map((i: { item: string }) => i.item)).toEqual([SITE_URL, `${SITE_URL}/shop`, `${SITE_URL}/type/resins`]);
  });
});

describe('home JSON-LD', () => {
  it('Organization with the store’s contacts and socials; WebSite with the site search', () => {
    const [org, site] = siteJsonLd({ store: { name: 'ArtQ', email: 'hello@artq.in', phone: null, whatsapp: null }, social: { instagram: 'https://instagram.com/artq', facebook: null, youtube: null, whatsapp: null } }) as Record<string, unknown>[];
    expect(org).toEqual({ '@context': 'https://schema.org', '@type': 'Organization', name: 'ArtQ', url: SITE_URL, email: 'hello@artq.in', sameAs: ['https://instagram.com/artq'] });
    expect(site).toMatchObject({ '@type': 'WebSite', potentialAction: { target: { urlTemplate: `${SITE_URL}/search?q={search_term_string}` } } });
  });
});

describe('sitemap and robots', () => {
  const entries: SitemapEntries = {
    products: [{ slug: 'clear-resin', updatedAt: '2026-10-01T00:00:00.000Z', image: 'https://cdn.test/r.webp' }, { slug: 'old-mould', updatedAt: '2026-09-01T00:00:00.000Z', image: null }],
    types: [{ slug: 'resins', updatedAt: '2026-10-02T00:00:00.000Z' }], categories: [{ slug: 'epoxy', updatedAt: '2026-10-02T00:00:00.000Z' }],
    techniques: [{ slug: 'pouring', updatedAt: '2026-10-02T00:00:00.000Z' }], pages: [{ slug: 'about', updatedAt: '2026-10-03T00:00:00.000Z' }, { slug: 'secret', updatedAt: '2026-10-03T00:00:00.000Z' }],
    noindex: ['/secret', '/trending'],
  };
  it('fixed pages + everything listed; hidden addresses left out; product images', async () => {
    routes['/seo/sitemap-entries'] = () => json(entries);
    const map = await buildSitemap();
    const urls = map.map((e) => e.url.replace(SITE_URL, '') || '/');
    expect(urls).toEqual(['/', '/shop', '/new-arrivals', '/faqs', '/contact', '/custom-work', '/type/resins', '/category/epoxy', '/technique/pouring', '/product/clear-resin', '/product/old-mould', '/about']);
    expect(map.find((e) => e.url.endsWith('/product/clear-resin'))).toEqual({ url: `${SITE_URL}/product/clear-resin`, lastModified: '2026-10-01T00:00:00.000Z', changeFrequency: 'weekly', priority: 0.6, images: ['https://cdn.test/r.webp'] });
    expect(map.find((e) => e.url.endsWith('/product/old-mould'))!.images).toBeUndefined();
  });
  it('the API down: the fixed pages are still listed', async () => {
    expect((await buildSitemap()).map((e) => e.url)).toEqual(['/', '/shop', '/new-arrivals', '/trending', '/faqs', '/contact', '/custom-work'].map((p) => (p === '/' ? SITE_URL : `${SITE_URL}${p}`)));
  });
  it('robots: private pages kept out, the sitemap linked; staging refuses every crawler', () => {
    const r = buildRobots(false);
    expect(r).toMatchObject({ rules: { userAgent: '*', allow: '/' }, sitemap: `${SITE_URL}/sitemap.xml` });
    expect((r.rules as { disallow: string[] }).disallow).toEqual(expect.arrayContaining(['/account', '/cart', '/checkout', '/track', '/reset-password', '/newsletter']));
    expect((r.rules as { disallow: string[] }).disallow).not.toContain('/shop');
    expect(buildRobots(true)).toEqual({ rules: { userAgent: '*', disallow: '/' } });
  });
});

describe('redirects (proxy.ts)', () => {
  const at = (path: string) => new URL(`https://artq.in${path}`);
  it('a hit moves the visitor; the visitor’s query is kept unless the target has its own; 302 kept', async () => {
    routes[resolveKey('/collections/resin')] = () => json({ redirect: { to: '/type/resins', status: 301 }, seo: null });
    routes[resolveKey('/sale')] = () => json({ redirect: { to: '/shop?sale=1', status: 302 }, seo: null });
    expect(await redirectFor(at('/Collections/Resin/?utm_source=ig'))).toEqual({ url: new URL('https://artq.in/type/resins?utm_source=ig'), status: 301 });
    expect(await redirectFor(at('/sale?utm_source=ig'))).toEqual({ url: new URL('https://artq.in/shop?sale=1'), status: 302 });
  });
  it('never to another site, even if the API said so', async () => {
    for (const to of ['//evil.example/x', 'https://evil.example', '/\\evil.example']) {
      clearRedirectMemo();
      routes[resolveKey('/x')] = () => json({ redirect: { to, status: 301 }, seo: null });
      expect(await redirectFor(at('/x')), to).toBeNull();
    }
  });
  it('remembered for a minute; failures are not remembered; the API down serves the page', async () => {
    routes[resolveKey('/old')] = () => json(none);
    const t = 1_000_000;
    expect(await redirectFor(at('/old'), t)).toBeNull();
    expect(await redirectFor(at('/old'), t + 59_000)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(await redirectFor(at('/old'), t + 60_001)).toBeNull();
    expect(calls).toHaveLength(2);
    routes[resolveKey('/flaky')] = () => json({}, 503);
    await redirectFor(at('/flaky'), t);
    routes[resolveKey('/flaky')] = () => json({ redirect: { to: '/faqs', status: 301 }, seo: null });
    expect((await redirectFor(at('/flaky'), t + 1))!.url.pathname).toBe('/faqs');
    expect(await redirectFor(at('/down'), t)).toBeNull();
  });
  it('the matcher skips every reserved shop address, internals and files, and looks up everything else', () => {
    const re = new RegExp(`^${config.matcher[0]}$`);
    for (const p of SEO_RESERVED_PREFIXES) {
      expect(re.test(p), p).toBe(false);
      expect(re.test(`${p}/anything`), `${p}/anything`).toBe(false);
    }
    for (const p of ['/', '/favicon.ico', '/sitemap.xml', '/robots.txt', '/_next/static/x.js', '/images/a.png']) expect(re.test(p), p).toBe(false);
    for (const p of ['/old-page', '/collections/resin', '/products/clear-resin', '/shopping', '/about', '/accounts-old']) expect(re.test(p), p).toBe(true);
  });
});
