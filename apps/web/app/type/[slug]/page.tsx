import type { Metadata } from 'next';
import { taxonomyMetadata, TaxonomyListing } from '../../../lib/taxonomy-page';
import type { SearchParams } from '../../../lib/listing';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return taxonomyMetadata('type', (await params).slug);
}

export default async function Page({ params, searchParams }: Props) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  return <TaxonomyListing kind="type" slug={slug} searchParams={sp} />;
}
