// /shop: every live product (product.md §3, §5.2); the chips lead to the type pages.
import type { Metadata } from 'next';
import { ListingPage } from '../../components/listing/ListingPage';
import { loadLayout } from '../../lib/api';
import type { SearchParams } from '../../lib/listing';

export const metadata: Metadata = { title: 'Shop all', description: 'Resin art supplies, wooden frames, moulds and pigments from ArtQ.' };

export default async function ShopPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [sp, { navigation }] = await Promise.all([searchParams, loadLayout()]);
  return <ListingPage searchParams={sp} fixed={{}} title="Shop all" crumbs={[{ name: 'Shop all' }]} chips={navigation.types.map((t) => ({ name: t.name, href: t.href }))} />;
}
