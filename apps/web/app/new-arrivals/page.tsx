import type { Metadata } from 'next';
import { ListingPage } from '../../components/listing/ListingPage';
import type { SearchParams } from '../../lib/listing';
import { withSeo } from '../../lib/seo';

// Filters and page numbers all canonical to the listing itself.
export function generateMetadata(): Promise<Metadata> {
  return withSeo('/new-arrivals', { title: 'New Arrivals', description: 'Our newly launched resins, frames and pigments.' });
}

export default async function NewArrivalsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return <ListingPage searchParams={await searchParams} fixed={{ isNew: true }} title="New Arrivals" description="Explore our newly launched products" crumbs={[{ name: 'New Arrivals' }]} />;
}
