// Structured data for search engines (task 3.6: JSON-LD on product pages). Stock here is the cached yes/no summary;
// exact stock is never published.
import type { ProductDetail } from '@artq/shared';

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const rupees = (paise: number) => (paise / 100).toFixed(2);
export const plainText = (html: string | null) => (html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();

export function productJsonLd(p: ProductDetail): object[] {
  const url = `${SITE_URL}/product/${p.slug}`;
  const description = plainText(p.description).slice(0, 5000) || p.shortDescription || undefined;
  const availability = `https://schema.org/${p.inStock ? 'InStock' : 'OutOfStock'}`;
  const offers = p.variants.length === 1
    ? { '@type': 'Offer', price: rupees(p.variants[0]!.price), priceCurrency: 'INR', availability, url, sku: p.variants[0]!.sku, itemCondition: 'https://schema.org/NewCondition' }
    : { '@type': 'AggregateOffer', lowPrice: rupees(p.fromPrice), highPrice: rupees(p.maxPrice), offerCount: p.variants.length, priceCurrency: 'INR', availability, url };
  const crumbs = [{ name: 'Home', item: SITE_URL }, { name: p.type.name, item: `${SITE_URL}/type/${p.type.slug}` },
    ...(p.category ? [{ name: p.category.name, item: `${SITE_URL}/category/${p.category.slug}` }] : []), { name: p.name, item: url }];
  return [
    {
      '@context': 'https://schema.org', '@type': 'Product', name: p.name, url, brand: { '@type': 'Brand', name: 'ArtQ' },
      ...(description ? { description } : {}), ...(p.images.length ? { image: p.images.map((i) => i.url) } : {}),
      ...(p.variants.length === 1 ? { sku: p.variants[0]!.sku } : {}), category: p.category?.name ?? p.type.name, offers,
    },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })) },
  ];
}

/** JSON for a <script type="application/ld+json">: "<" escaped so text from the catalogue can never close the tag. */
export const jsonLdScript = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');
