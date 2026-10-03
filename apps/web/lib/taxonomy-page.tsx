// Shared by /type/[slug], /category/[slug], /technique/[slug]: header from the API, redirects for renamed slugs (filters
// kept), 404 for unknown or switched-off ones, and the listing. If the API is down the page still renders and says so.
import type { TaxonomyPage } from '@artq/shared';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { ListingPage } from '../components/listing/ListingPage';
import { loadTaxonomy } from './api';
import { listingSearch, parseListing, type SearchParams } from './listing';

const BASE = { type: '/type', category: '/category', technique: '/technique' } as const;
const human = (slug: string) => slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

export async function taxonomyMetadata(kind: TaxonomyPage['kind'], slug: string): Promise<Metadata> {
  const t = await loadTaxonomy(kind, slug);
  if (typeof t !== 'object' || 'redirectTo' in t) return {};
  return { title: t.metaTitle ?? t.name, ...(t.metaDescription ?? t.description ? { description: (t.metaDescription ?? t.description)! } : {}) };
}

export async function TaxonomyListing({ kind, slug, searchParams }: { kind: TaxonomyPage['kind']; slug: string; searchParams: SearchParams }) {
  const t = await loadTaxonomy(kind, slug);
  if (t === 'missing') notFound();
  if (typeof t === 'object' && 'redirectTo' in t) permanentRedirect(`${BASE[kind]}/${t.redirectTo}${listingSearch(parseListing(searchParams))}`);
  const page = typeof t === 'object' ? t : null;
  const name = page?.name ?? human(slug);
  if (kind === 'type') {
    return <ListingPage searchParams={searchParams} fixed={{ type: slug }} title={name} description={page?.description} banner={page?.banner} crumbs={[{ name: 'Shop all', href: '/shop' }, { name }]}
      chips={page?.children.map((c) => ({ name: c.name, href: `/category/${c.slug}` }))} hide={['type']} />;
  }
  if (kind === 'category') {
    return <ListingPage searchParams={searchParams} fixed={{ category: slug }} title={name} description={page?.description} banner={page?.banner}
      crumbs={[...(page?.parent ? [{ name: page.parent.name, href: `/type/${page.parent.slug}` }] : [{ name: 'Shop all', href: '/shop' }]), { name }]} hide={['type', 'category']} />;
  }
  return <ListingPage searchParams={searchParams} fixed={{ technique: slug }} title={name} eyebrow="Technique" description={page?.description} banner={page?.banner} crumbs={[{ name: 'Shop all', href: '/shop' }, { name }]} hide={['technique']} />;
}
