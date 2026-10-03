// Search (api.md §3.3, task 3.7). GET /v1/search is the listing with a query, logged in search_logs (first page only,
// so "Load more" is not counted again; a logging failure never fails the search) and, when nothing matches, the
// closest product name by trigram word similarity ("Did you mean …"). GET /v1/search/suggest answers the header
// search box from 2 characters: products (word prefixes, the name, or a close spelling), types and categories.
import type { SearchResults, SearchSuggestions, StorefrontListQuery } from '@artq/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import { productCards, type MediaUrl } from './home.js';
import { listProducts, prefixQuery } from './listing.js';

/** How close a misspelling may be (pg_trgm word_similarity, 0–1). */
const TYPO = 0.4;
export const normalizeQuery = (q: string) => q.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export async function search(prisma: PrismaClient, q: StorefrontListQuery & { q: string }, url: MediaUrl, onLogError?: (e: unknown) => void): Promise<SearchResults> {
  const list = await listProducts(prisma, q, url);
  let suggestion: string | null = null;
  if (list.meta.total === 0) {
    const [best] = await prisma.$queryRaw<{ name: string }[]>`
      SELECT p.name FROM products p WHERE p.status = 'ACTIVE' AND p.deleted_at IS NULL AND word_similarity(${q.q}, p.name) > ${TYPO}
      ORDER BY word_similarity(${q.q}, p.name) DESC, p.id LIMIT 1`;
    suggestion = best?.name ?? null;
  }
  if (q.page === 1) {
    await prisma.searchLog.create({ data: { query: q.q.slice(0, 120), normalized: normalizeQuery(q.q), resultsCount: list.meta.total } }).catch((e: unknown) => onLogError?.(e));
  }
  return { ...list, query: q.q, suggestion };
}

export async function suggest(prisma: PrismaClient, q: string, url: MediaUrl): Promise<SearchSuggestions> {
  const tsq = prefixQuery(q);
  const like = likePattern(q);
  // Without searchable words (only symbols) there is no text match; PostgreSQL refuses a constant in ORDER BY, so the
  // match term is only ordered on when it exists.
  const match = tsq ? Prisma.sql`p.search_vector @@ to_tsquery('simple', ${tsq})` : Prisma.sql`false`;
  const live = Prisma.sql`EXISTS (SELECT 1 FROM products lp WHERE lp.status = 'ACTIVE' AND lp.deleted_at IS NULL`;
  const [ids, categories, types] = await Promise.all([
    prisma.$queryRaw<{ id: number }[]>`
      SELECT p.id FROM products p
      WHERE p.status = 'ACTIVE' AND p.deleted_at IS NULL AND p.min_price IS NOT NULL
        AND (${match} OR p.name ILIKE ${like} OR word_similarity(${q}, p.name) > ${TYPO})
      ORDER BY ${tsq ? Prisma.sql`(${match}) DESC,` : Prisma.empty} word_similarity(${q}, p.name) DESC, p.is_featured DESC, p.id
      LIMIT 6`,
    prisma.$queryRaw<{ slug: string; name: string; type_name: string }[]>`
      SELECT c.slug, c.name, t.name AS type_name FROM categories c JOIN product_types t ON t.id = c.type_id
      WHERE c.is_active AND t.is_active AND (c.name ILIKE ${like} OR word_similarity(${q}, c.name) > ${TYPO})
        AND ${live} AND lp.category_id = c.id)
      ORDER BY word_similarity(${q}, c.name) DESC, c.sort_order, c.id LIMIT 3`,
    prisma.$queryRaw<{ slug: string; name: string; tile_link_url: string | null }[]>`
      SELECT t.slug, t.name, t.tile_link_url FROM product_types t
      WHERE t.is_active AND (t.name ILIKE ${like} OR word_similarity(${q}, t.name) > ${TYPO}) AND ${live} AND lp.type_id = t.id)
      ORDER BY word_similarity(${q}, t.name) DESC, t.sort_order, t.id LIMIT 3`,
  ]);
  const order = ids.map((r) => Number(r.id));
  const cards = order.length ? await productCards(prisma, Prisma.sql`p.id = ANY(${order})`, Prisma.sql`array_position(${order}::int[], p.id)`, order.length, url) : [];
  return {
    products: cards.map((c) => ({ id: c.id, slug: c.slug, name: c.name, image: c.image, fromPrice: c.fromPrice })),
    categories: categories.map((c) => ({ slug: c.slug, name: c.name, typeName: c.type_name })),
    types: types.map((t) => ({ slug: t.slug, name: t.name, href: t.tile_link_url ?? `/type/${t.slug}` })),
  };
}

