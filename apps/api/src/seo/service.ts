// SEO lookups (task 6.4; api.md §3.1). `resolve` answers the storefront's proxy and page metadata: a hand-made
// redirect for the address (followed up to 3 hops; a loop counts as none) and any title / description / canonical /
// noindex override. `sitemapEntries` lists what a visitor can open, with when it last changed.
import { normalizeSeoPath, type SeoResolve, type SitemapEntries } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import type { MediaUrl } from '../storefront/home.js';

export const MAX_REDIRECT_HOPS = 3;

export async function resolveSeo(prisma: PrismaClient, path: string): Promise<SeoResolve> {
  const [redirect, o] = await Promise.all([followRedirects(prisma, path), prisma.seoOverride.findUnique({ where: { path } })]);
  return { redirect, seo: o ? { metaTitle: o.metaTitle, metaDescription: o.metaDescription, canonical: o.canonical, noindex: o.noindex } : null };
}

async function followRedirects(prisma: PrismaClient, path: string): Promise<SeoResolve['redirect']> {
  const seen = new Set([path]);
  let hit = null as SeoResolve['redirect'];
  let at = path;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const r = await prisma.redirect.findUnique({ where: { fromPath: at } });
    if (!r) return hit;
    const next = normalizeSeoPath(r.toPath);
    if (seen.has(next)) return null;   // a loop: serve the page (or 404) rather than bounce the visitor
    seen.add(next);
    // A temporary hop anywhere in the chain keeps the whole move temporary.
    hit = { to: r.toPath, status: hit?.status === 302 || r.statusCode === 302 ? 302 : 301 };
    at = next;
  }
  return hit;
}

const live = { status: 'ACTIVE' as const, deletedAt: null };
const iso = (d: Date) => d.toISOString();

export async function sitemapEntries(prisma: PrismaClient, mediaUrl: MediaUrl): Promise<SitemapEntries> {
  const [products, types, categories, techniques, pages, hidden] = await Promise.all([
    prisma.product.findMany({
      where: { ...live, variants: { some: { isActive: true, deletedAt: null, price: { not: null } } } }, orderBy: { id: 'asc' }, take: 45_000,
      select: { slug: true, updatedAt: true, images: { where: { media: { status: 'READY', visibility: 'PUBLIC', kind: 'IMAGE', deletedAt: null } }, select: { media: { select: { key: true } } }, orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }], take: 1 } },
    }),
    prisma.productType.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { slug: true, updatedAt: true } }),
    prisma.category.findMany({ where: { isActive: true, type: { isActive: true } }, orderBy: { sortOrder: 'asc' }, select: { slug: true, updatedAt: true } }),
    prisma.technique.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { slug: true, updatedAt: true } }),
    prisma.cmsPage.findMany({ where: { isPublished: true }, orderBy: { slug: 'asc' }, select: { slug: true, updatedAt: true } }),
    prisma.seoOverride.findMany({ where: { noindex: true }, select: { path: true } }),
  ]);
  const plain = (rows: { slug: string; updatedAt: Date }[]) => rows.map((r) => ({ slug: r.slug, updatedAt: iso(r.updatedAt) }));
  return {
    products: products.map((p) => ({ slug: p.slug, updatedAt: iso(p.updatedAt), image: p.images[0] ? mediaUrl(p.images[0].media.key) : null })),
    types: plain(types), categories: plain(categories), techniques: plain(techniques), pages: plain(pages),
    noindex: hidden.map((h) => h.path),
  };
}
