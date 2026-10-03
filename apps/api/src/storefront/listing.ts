// GET /v1/products (api.md §3.3, product.md §5.2, architecture.md §6.2) and the listing-page headers
// (GET /v1/types/:slug, /categories/:slug, /techniques/:slug).
//
// Same-variant rule: the listing joins products to their variants and keeps a product when at least one variant meets
// every variant filter at once (size, colour, thickness, price, in stock, on sale). So "Gold + in stock" never matches a
// product whose gold variant is sold out while another colour is in stock. The card's "From ₹" and price sorting use
// the cheapest matching variant. Facet counts apply every filter except their own dimension, with the same rule.
import { discountPercent, type Facet, type ProductList, type StorefrontListQuery, type TaxonomyPage } from '@artq/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import { cardsFromRows, mediaRef, type CardRow, type MediaUrl } from './home.js';

type ProductDim = 'type' | 'category' | 'technique';
type VariantDim = 'size' | 'color' | 'thickness' | 'price';
const and = (parts: Prisma.Sql[]) => (parts.length ? Prisma.join(parts, ' AND ') : Prisma.sql`true`);

/** Words of a search as a prefix tsquery ("mica gol" → mica:* & gol:*); null when nothing searchable remains. */
export function prefixQuery(q: string): string | null {
  const words = q.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean).slice(0, 8);
  return words.length ? words.map((w) => `${w}:*`).join(' & ') : null;
}

function productConds(q: StorefrontListQuery, except?: ProductDim): Prisma.Sql[] {
  const c: Prisma.Sql[] = [Prisma.sql`p.status = 'ACTIVE'`, Prisma.sql`p.deleted_at IS NULL`];
  if (q.type?.length && except !== 'type') c.push(Prisma.sql`t.slug = ANY(${q.type})`);
  if (q.category?.length && except !== 'category') c.push(Prisma.sql`EXISTS (SELECT 1 FROM categories c WHERE c.id = p.category_id AND c.slug = ANY(${q.category}))`);
  if (q.technique?.length && except !== 'technique') c.push(Prisma.sql`EXISTS (SELECT 1 FROM product_techniques pt JOIN techniques te ON te.id = pt.technique_id WHERE pt.product_id = p.id AND te.is_active AND te.slug = ANY(${q.technique}))`);
  if (q.isNew) c.push(Prisma.sql`p.is_new_arrival`);
  if (q.isTrending) c.push(Prisma.sql`p.is_trending`);
  if (q.q) {
    const tsq = prefixQuery(q.q);
    const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    c.push(tsq ? Prisma.sql`(p.search_vector @@ to_tsquery('simple', ${tsq}) OR p.name ILIKE ${like})` : Prisma.sql`p.name ILIKE ${like}`);
  }
  return c;
}

function variantConds(q: StorefrontListQuery, except?: VariantDim): Prisma.Sql[] {
  const c: Prisma.Sql[] = [Prisma.sql`v.is_active`, Prisma.sql`v.deleted_at IS NULL`, Prisma.sql`v.price IS NOT NULL`];
  if (q.size?.length && except !== 'size') c.push(Prisma.sql`v.size = ANY(${q.size})`);
  if (q.color?.length && except !== 'color') c.push(Prisma.sql`v.color = ANY(${q.color})`);
  if (q.thickness?.length && except !== 'thickness') c.push(Prisma.sql`v.thickness = ANY(${q.thickness})`);
  if (q.minPrice !== undefined && except !== 'price') c.push(Prisma.sql`v.price >= ${q.minPrice}`);
  if (q.maxPrice !== undefined && except !== 'price') c.push(Prisma.sql`v.price <= ${q.maxPrice}`);
  if (q.inStock) c.push(Prisma.sql`v.on_hand - v.reserved > 0`);
  if (q.sale) c.push(Prisma.sql`v.mrp > v.price`);
  return c;
}

const FROM = Prisma.sql`FROM products p JOIN product_types t ON t.id = p.type_id JOIN product_variants v ON v.product_id = p.id`;

function orderBy(sort: string, tsq: string | null): Prisma.Sql {
  switch (sort) {
    case 'newest': return Prisma.sql`p.published_at DESC NULLS LAST, p.id DESC`;
    case 'price_asc': return Prisma.sql`m.from_price ASC, p.id ASC`;
    case 'price_desc': return Prisma.sql`m.from_price DESC, p.id DESC`;
    case 'name_asc': return Prisma.sql`lower(p.name) ASC, p.id ASC`;
    case 'best_selling': return Prisma.sql`coalesce(s.sold, 0) DESC, p.is_featured DESC, p.published_at DESC NULLS LAST, p.id DESC`;
    case 'relevance': return tsq ? Prisma.sql`ts_rank(p.search_vector, to_tsquery('simple', ${tsq})) DESC, p.is_featured DESC, p.id DESC` : Prisma.sql`p.is_featured DESC, p.id DESC`;
    default: return Prisma.sql`p.is_featured DESC, p.is_trending DESC, p.is_new_arrival DESC, p.published_at DESC NULLS LAST, p.id DESC`;
  }
}

/** Selected values are always listed (count 0 when nothing matches) so they can be removed. */
function keepSelected(facets: Facet[], selected: string[] | undefined, label = (v: string) => v): Facet[] {
  const out = [...facets];
  for (const v of selected ?? []) if (!out.some((f) => f.value === v)) out.push({ value: v, label: label(v), count: 0 });
  return out;
}

export async function listProducts(prisma: PrismaClient, q: StorefrontListQuery, url: MediaUrl): Promise<ProductList> {
  const sort = q.sort ?? (q.q ? 'relevance' : 'featured');
  const tsq = q.q ? prefixQuery(q.q) : null;
  const where = and([...productConds(q), ...variantConds(q)]);
  const matched = Prisma.sql`SELECT p.id, min(v.price) AS from_price, max(v.price) AS max_match, (array_agg(v.mrp ORDER BY v.price, v.id))[1] AS cheapest_mrp ${FROM} WHERE ${where} GROUP BY p.id`;
  const sales = sort === 'best_selling'
    ? Prisma.sql`LEFT JOIN LATERAL (SELECT sum(oi.quantity) AS sold FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.product_id = p.id AND o.payment_status IN ('PAID', 'PARTIALLY_REFUNDED', 'COD_COLLECTED', 'COD_REMITTED') AND o.created_at > now() - interval '90 days') s ON true`
    : Prisma.empty;
  const offset = (q.page - 1) * q.limit;

  const [rows, [totalRow], sizes, colors, thicknesses, [price], types, categories, techniques] = await Promise.all([
    prisma.$queryRaw<CardRow[]>`
      WITH m AS (${matched})
      SELECT p.id, p.slug, p.name, m.from_price AS min_price, m.max_match AS max_price, p.available_qty, p.active_variant_count, p.is_new_arrival, p.is_trending,
             t.slug AS type_slug, t.name AS type_name, m.cheapest_mrp,
             CASE WHEN p.active_variant_count = 1 THEN (SELECT v1.id FROM product_variants v1 WHERE v1.product_id = p.id AND v1.is_active AND v1.deleted_at IS NULL AND v1.price IS NOT NULL ORDER BY v1.id LIMIT 1) END AS single_variant_id
      FROM m JOIN products p ON p.id = m.id JOIN product_types t ON t.id = p.type_id ${sales}
      ORDER BY ${orderBy(sort, tsq)}
      LIMIT ${q.limit} OFFSET ${offset}`,
    prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM (${matched}) m`,
    prisma.$queryRaw<{ value: string; count: number }[]>`SELECT v.size AS value, count(DISTINCT p.id)::int AS count ${FROM}
      WHERE ${and([...productConds(q), ...variantConds(q, 'size'), Prisma.sql`v.size IS NOT NULL`])} GROUP BY v.size ORDER BY min(v.net_unit), min(v.net_quantity) NULLS LAST, v.size`,
    prisma.$queryRaw<{ value: string; hex: string | null; count: number }[]>`SELECT v.color AS value, max(v.color_hex) AS hex, count(DISTINCT p.id)::int AS count ${FROM}
      WHERE ${and([...productConds(q), ...variantConds(q, 'color'), Prisma.sql`v.color IS NOT NULL`])} GROUP BY v.color ORDER BY v.color`,
    prisma.$queryRaw<{ value: string; count: number }[]>`SELECT v.thickness AS value, count(DISTINCT p.id)::int AS count ${FROM}
      WHERE ${and([...productConds(q), ...variantConds(q, 'thickness'), Prisma.sql`v.thickness IS NOT NULL`])} GROUP BY v.thickness ORDER BY v.thickness`,
    prisma.$queryRaw<{ min: number | null; max: number | null }[]>`SELECT min(v.price)::int AS min, max(v.price)::int AS max ${FROM} WHERE ${and([...productConds(q), ...variantConds(q, 'price')])}`,
    prisma.$queryRaw<{ value: string; label: string; count: number }[]>`SELECT t.slug AS value, t.name AS label, count(DISTINCT p.id)::int AS count ${FROM}
      WHERE ${and([...productConds(q, 'type'), ...variantConds(q), Prisma.sql`t.is_active`])} GROUP BY t.slug, t.name, t.sort_order, t.id ORDER BY t.sort_order, t.id`,
    prisma.$queryRaw<{ value: string; label: string; count: number }[]>`SELECT c.slug AS value, c.name AS label, count(DISTINCT p.id)::int AS count ${FROM} JOIN categories c ON c.id = p.category_id
      WHERE ${and([...productConds(q, 'category'), ...variantConds(q), Prisma.sql`c.is_active`])} GROUP BY c.slug, c.name, c.sort_order, c.id ORDER BY c.sort_order, c.id`,
    prisma.$queryRaw<{ value: string; label: string; count: number }[]>`SELECT te.slug AS value, te.name AS label, count(DISTINCT p.id)::int AS count ${FROM}
      JOIN product_techniques pt ON pt.product_id = p.id JOIN techniques te ON te.id = pt.technique_id
      WHERE ${and([...productConds(q, 'technique'), ...variantConds(q), Prisma.sql`te.is_active`])} GROUP BY te.slug, te.name, te.sort_order, te.id ORDER BY te.sort_order, te.id`,
  ]);

  const total = Number(totalRow?.total ?? 0);
  const data = await cardsFromRows(prisma, rows, url);
  // Matching-variant discount: the cheapest matching variant's MRP against its price.
  for (const c of data) { c.discountPercent = discountPercent(c.fromPrice, c.mrp); }
  // Names for selected taxonomy values that matched nothing (shown as removable chips with count 0).
  const [typeNames, categoryNames, techniqueNames] = await Promise.all([
    q.type?.length ? prisma.productType.findMany({ where: { slug: { in: q.type } }, select: { slug: true, name: true } }) : [],
    q.category?.length ? prisma.category.findMany({ where: { slug: { in: q.category } }, select: { slug: true, name: true } }) : [],
    q.technique?.length ? prisma.technique.findMany({ where: { slug: { in: q.technique } }, select: { slug: true, name: true } }) : [],
  ]);
  const nameOf = (list: { slug: string; name: string }[]) => (slug: string) => list.find((x) => x.slug === slug)?.name ?? slug;
  const plain = (xs: { value: string; count: number; hex?: string | null }[]): Facet[] => xs.map((x) => ({ value: x.value, label: x.value, count: Number(x.count), ...(x.hex !== undefined ? { hex: x.hex } : {}) }));
  const named = (xs: { value: string; label: string; count: number }[]): Facet[] => xs.map((x) => ({ value: x.value, label: x.label, count: Number(x.count) }));
  return {
    data,
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
    facets: {
      types: keepSelected(named(types), q.type, nameOf(typeNames)), categories: keepSelected(named(categories), q.category, nameOf(categoryNames)), techniques: keepSelected(named(techniques), q.technique, nameOf(techniqueNames)),
      sizes: keepSelected(plain(sizes), q.size), colors: keepSelected(plain(colors), q.color), thicknesses: keepSelected(plain(thicknesses), q.thickness),
      price: price && price.min !== null && price.max !== null ? { min: Number(price.min), max: Number(price.max) } : null,
    },
  };
}

/** Listing header for an active type/category/technique; an old slug → {redirectTo}; anything else → null (404). */
export async function loadTaxonomyPage(prisma: PrismaClient, kind: TaxonomyPage['kind'], slug: string, url: MediaUrl): Promise<TaxonomyPage | { redirectTo: string } | null> {
  const live = { status: 'ACTIVE' as const, deletedAt: null };
  let page: TaxonomyPage | null = null;
  if (kind === 'type') {
    const t = await prisma.productType.findFirst({ where: { slug, isActive: true }, include: { banner: true, image: true, categories: { where: { isActive: true, products: { some: live } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } } });
    if (t) page = { kind, name: t.name, slug: t.slug, description: t.description, banner: mediaRef(t.banner, t.name, url) ?? mediaRef(t.image, t.name, url), metaTitle: t.metaTitle, metaDescription: t.metaDescription, parent: null, children: t.categories.map((c) => ({ slug: c.slug, name: c.name })) };
  } else if (kind === 'category') {
    const c = await prisma.category.findFirst({ where: { slug, isActive: true, type: { isActive: true } }, include: { image: true, type: true } });
    if (c) page = { kind, name: c.name, slug: c.slug, description: c.description, banner: mediaRef(c.image, c.name, url), metaTitle: c.metaTitle, metaDescription: c.metaDescription, parent: { slug: c.type.slug, name: c.type.name }, children: [] };
  } else {
    const te = await prisma.technique.findFirst({ where: { slug, isActive: true }, include: { hero: true, image: true } });
    if (te) page = { kind, name: te.name, slug: te.slug, description: te.description, banner: mediaRef(te.hero, te.name, url) ?? mediaRef(te.image, te.name, url), metaTitle: te.metaTitle, metaDescription: te.metaDescription, parent: null, children: [] };
  }
  if (page) return page;
  const r = await prisma.slugRedirect.findUnique({ where: { entity_oldSlug: { entity: kind, oldSlug: slug } } });
  return r ? { redirectTo: r.newSlug } : null;
}
