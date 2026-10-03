// Public product detail (GET /v1/products/:slug, cacheable) and live availability (GET …/availability, no-store) — api.md
// §3.3. Only ACTIVE products; only active variants with a price. Stock is never in the cached detail: pages ask for
// availability in the browser, so a cached page can never promise stock that is gone.
import { discountPercent, MAX_CART_QUANTITY, type Availability, type ProductCard, type ProductDetail, type PublicVariant, type RelatedProducts, type StockStatus } from '@artq/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import { mediaRef, productCards, videoRef, type MediaUrl } from './home.js';

const sellableVariants = { isActive: true, deletedAt: null, price: { not: null } } satisfies Prisma.ProductVariantWhereInput;

/** Live product id for a slug; an old slug answers with where it moved; anything else (draft, archived, unknown) → null. */
export async function findLiveProduct(prisma: PrismaClient, slug: string): Promise<{ id: number } | { redirectTo: string } | null> {
  const p = await prisma.product.findFirst({ where: { slug, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
  if (p) return p;
  const r = await prisma.slugRedirect.findUnique({ where: { entity_oldSlug: { entity: 'product', oldSlug: slug } } });
  if (!r) return null;
  const target = await prisma.product.findFirst({ where: { slug: r.newSlug, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
  return target ? { redirectTo: r.newSlug } : null;
}

export function stockStatus(available: number, lowThreshold: number): StockStatus {
  if (available <= 0) return 'OUT_OF_STOCK';
  return available <= lowThreshold ? 'LOW_STOCK' : 'IN_STOCK';
}

export async function loadProductDetail(prisma: PrismaClient, id: number, url: MediaUrl): Promise<ProductDetail | null> {
  const p = await prisma.product.findFirst({
    where: { id, status: 'ACTIVE', deletedAt: null },
    include: {
      type: true, category: true, video: true,
      techniques: { where: { technique: { isActive: true } }, include: { technique: true }, orderBy: { technique: { sortOrder: 'asc' } } },
      images: { where: { media: { status: 'READY', visibility: 'PUBLIC', kind: 'IMAGE', deletedAt: null } }, include: { media: true }, orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }] },
      variants: { where: sellableVariants, include: { image: true }, orderBy: [{ price: 'asc' }, { id: 'asc' }] },
    },
  });
  if (!p || !p.type || p.variants.length === 0) return null;
  const variants: PublicVariant[] = p.variants.map((v) => ({
    id: v.id, sku: v.sku, label: v.label, size: v.size, color: v.color, colorHex: v.colorHex, thickness: v.thickness,
    price: v.price!, mrp: v.mrp !== null && v.mrp > v.price! ? v.mrp : null, discountPercent: discountPercent(v.price!, v.mrp), image: mediaRef(v.image, `${p.name}, ${v.label}`, url),
  }));
  // A dimension is offered only when it has more than one value (product.md §5.3).
  const distinct = <T>(xs: (T | null)[]) => [...new Set(xs.filter((x): x is T => x !== null))];
  const sizes = distinct(variants.map((v) => v.size));
  const colors = distinct(variants.map((v) => v.color));
  const thicknesses = distinct(variants.map((v) => v.thickness));
  return {
    id: p.id, slug: p.slug, name: p.name, shortDescription: p.shortDescription, description: p.description,
    type: { slug: p.type.slug, name: p.type.name }, category: p.category ? { slug: p.category.slug, name: p.category.name } : null,
    images: p.images.flatMap((i) => { const m = mediaRef(i.media, i.alt ?? p.name, url); return m ? [m] : []; }),
    variants,
    options: {
      size: sizes.length > 1 ? sizes : [],
      color: colors.length > 1 ? colors.map((name) => ({ name, hex: variants.find((v) => v.color === name)?.colorHex ?? null })) : [],
      thickness: thicknesses.length > 1 ? thicknesses : [],
    },
    fromPrice: Math.min(...variants.map((v) => v.price)), maxPrice: Math.max(...variants.map((v) => v.price)),
    isNew: p.isNewArrival, isTrending: p.isTrending,
    productDetails: p.productDetails, specificationsCare: p.specificationsCare, howToUse: p.howToUse,
    // Stored as a jsonb object, which does not keep the admin's order: shown alphabetically until it becomes a list.
    specifications: Object.entries((p.specifications ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([label, value]) => ({ label, value: String(value) })).sort((a, b) => a.label.localeCompare(b.label, 'en')),
    techniques: p.techniques.map((t) => ({ slug: t.technique.slug, name: t.technique.name })),
    video: videoRef(p.video, url),
    metaTitle: p.metaTitle, metaDescription: p.metaDescription,
    inStock: p.availableQty > 0,
  };
}

const CARD_LIMIT = 8;

/** "Frequently bought together" (other products in the same paid orders, most often first) and "Similar" (same category, then same type). */
export async function loadRelated(prisma: PrismaClient, id: number, url: MediaUrl): Promise<RelatedProducts> {
  const p = await prisma.product.findFirst({ where: { id, status: 'ACTIVE', deletedAt: null }, select: { typeId: true, categoryId: true } });
  if (!p) return { frequentlyBoughtTogether: [], similar: [] };
  const together = await prisma.$queryRaw<{ product_id: number }[]>`
    SELECT oi2.product_id FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN order_items oi2 ON oi2.order_id = oi.order_id AND oi2.product_id <> oi.product_id
    WHERE oi.product_id = ${id} AND o.payment_status IN ('PAID', 'PARTIALLY_REFUNDED', 'COD_COLLECTED', 'COD_REMITTED')
    GROUP BY oi2.product_id ORDER BY count(DISTINCT oi.order_id) DESC, oi2.product_id LIMIT 4`;
  const ids = together.map((r) => Number(r.product_id));
  const [frequentlyBoughtTogether, similar] = await Promise.all([
    ids.length ? productCards(prisma, Prisma.sql`p.id = ANY(${ids})`, Prisma.sql`array_position(${ids}::int[], p.id)`, 4, url) : Promise.resolve([]),
    productCards(prisma, Prisma.sql`p.id <> ${id} AND (p.category_id = ${p.categoryId} OR p.type_id = ${p.typeId})`,
      Prisma.sql`(p.category_id = ${p.categoryId}) DESC, p.is_featured DESC, p.published_at DESC NULLS LAST, p.id DESC`, CARD_LIMIT, url),
  ]);
  return { frequentlyBoughtTogether, similar: similar.filter((c) => !ids.includes(c.id)) };
}

/** Cards for ids in the given order (recently viewed); anything not live is skipped. */
export async function cardsByIds(prisma: PrismaClient, ids: number[], url: MediaUrl): Promise<ProductCard[]> {
  if (ids.length === 0) return [];
  return productCards(prisma, Prisma.sql`p.id = ANY(${ids})`, Prisma.sql`array_position(${ids}::int[], p.id)`, ids.length, url);
}

export async function loadAvailability(prisma: PrismaClient, id: number): Promise<Availability> {
  const variants = await prisma.productVariant.findMany({ where: { productId: id, ...sellableVariants, product: { status: 'ACTIVE', deletedAt: null } }, orderBy: [{ price: 'asc' }, { id: 'asc' }] });
  return {
    variants: variants.map((v) => {
      const available = Math.max(0, v.onHand - v.reserved);
      return { id: v.id, price: v.price!, mrp: v.mrp !== null && v.mrp > v.price! ? v.mrp : null, discountPercent: discountPercent(v.price!, v.mrp), stockStatus: stockStatus(available, v.lowStockThreshold), maxQuantity: Math.min(available, MAX_CART_QUANTITY) };
    }),
  };
}
