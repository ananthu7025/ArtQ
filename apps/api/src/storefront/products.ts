// Public product detail (GET /v1/products/:slug, cacheable) and live availability (GET …/availability, no-store) — api.md
// §3.3. Only ACTIVE products; only active variants with a price. Stock is never in the cached detail: pages ask for
// availability in the browser, so a cached page can never promise stock that is gone.
import { discountPercent, MAX_CART_QUANTITY, type Availability, type ProductDetail, type PublicVariant, type StockStatus } from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { mediaRef, type MediaUrl } from './home.js';

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
      type: true, category: true,
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
  };
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
