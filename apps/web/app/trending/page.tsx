import type { Metadata } from 'next';
import { ListingPage } from '../../components/listing/ListingPage';
import type { SearchParams } from '../../lib/listing';
import { withSeo } from '../../lib/seo';

// Filters and page numbers all canonical to the listing itself.
export function generateMetadata(): Promise<Metadata> {
  return withSeo('/trending', { title: 'Trending now', description: 'What makers are buying right now at ArtQ.' });
}

export default async function TrendingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return <ListingPage searchParams={await searchParams} fixed={{ isTrending: true }} title="Trending now" crumbs={[{ name: 'Trending now' }]} />;
}
