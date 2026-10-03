// /search?q= (product.md §5.4, task 3.7): results on the listing template with the same filters; "Did you mean …" when
// nothing matches. Search pages are not indexed. Without a query: the search box and the product types.
import type { Metadata } from 'next';
import Link from 'next/link';
import { SearchForm } from '../../components/layout/SearchForm';
import { ListingPage } from '../../components/listing/ListingPage';
import { loadLayout } from '../../lib/api';
import { parseListing, type SearchParams } from '../../lib/listing';

type Props = { searchParams: Promise<SearchParams> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { q } = parseListing(await searchParams);
  return { title: q ? `Search: ${q}` : 'Search', robots: { index: false, follow: true } };
}

export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const { q } = parseListing(sp);
  if (!q) {
    const { navigation } = await loadLayout();
    return (
      <div className="mx-auto max-w-[760px] px-4 py-12 md:px-6">
        <h1 className="font-display text-[26px] font-semibold text-ink-900 md:text-4xl">Search</h1>
        <p className="mb-6 mt-2 text-ink-700">Find resins, frames, pigments and more.</p>
        <SearchForm id="page-search" autoFocus />
        {navigation.types.length > 0 && (
          <nav aria-label="Browse by type" className="mt-10">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.12em] text-ink-900">Or browse</h2>
            <ul className="flex flex-wrap gap-2">{navigation.types.map((t) => <li key={t.id}><Link href={t.href} className="inline-flex min-h-10 items-center rounded-full border border-border-input px-4 text-sm text-ink-900 hover:border-brand-700 hover:text-brand-700">{t.name}</Link></li>)}</ul>
          </nav>
        )}
      </div>
    );
  }
  return <ListingPage search searchParams={sp} fixed={{}} title={`Results for “${q}”`} crumbs={[{ name: 'Search', href: '/search' }, { name: q }]} />;
}
