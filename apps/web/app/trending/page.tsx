import type { Metadata } from 'next';
import { ListingPage } from '../../components/listing/ListingPage';
import type { SearchParams } from '../../lib/listing';

export const metadata: Metadata = { title: 'Trending now', description: 'What makers are buying right now at ArtQ.' };

export default async function TrendingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return <ListingPage searchParams={await searchParams} fixed={{ isTrending: true }} title="Trending now" crumbs={[{ name: 'Trending now' }]} />;
}
