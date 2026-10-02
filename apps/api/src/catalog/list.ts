// GET /admin/products (api.md §4.3): the Products page listing. One SQL query: filters, live readiness
// (product_readiness_failures, the same gate as publish), cover image state, stock signals, deletability, page + total.
import type { ImageState, ProductListQuery, ProductListRow } from '@artq/shared';
import { Prisma, type Media, type PrismaClient } from '@prisma/client';

type Row = {
  id: number; name: string; slug: string; status: ProductListRow['status']; failures: string[];
  type_id: number | null; type_name: string | null; category_id: number | null; category_name: string | null;
  cover_media_id: number | null; cover_status: string | null; variant_count: number; active_variant_count: number;
  min_price: number | null; max_price: number | null; available_qty: number; low_stock: boolean; oversold: boolean;
  flags: string[]; deletable: boolean; updated_at: Date; version: number;
};

/** Cover media status → what the page shows (product.md §7.3: processing, failed and missing look different). */
export function imageState(status: string | null): ImageState {
  if (status === null) return 'MISSING';
  if (status === 'READY') return 'READY';
  if (status === 'FAILED' || status === 'REJECTED') return 'FAILED';
  return 'PROCESSING';   // PENDING_UPLOAD, UPLOADED, PROCESSING
}

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listProducts(prisma: PrismaClient, q: ProductListQuery, renderMedia: (m: Media) => { renditions?: Record<string, string> }) {
  const where: Prisma.Sql[] = [Prisma.sql`p.deleted_at IS NULL`];
  if (q.q) {
    const pat = like(q.q);
    where.push(Prisma.sql`(p.name ILIKE ${pat} OR p.slug ILIKE ${pat}
      OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.sku ILIKE ${pat}))`);
  }
  if (q.type === 'unassigned') where.push(Prisma.sql`p.type_id IS NULL`);
  else if (q.type !== undefined) where.push(Prisma.sql`p.type_id = ${q.type}`);
  if (q.status) where.push(Prisma.sql`p.status::text IN (${Prisma.join(q.status)})`);
  if (q.flag) {
    where.push(Prisma.sql`(${q.flag} = ANY(p.data_flags)
      OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.deleted_at IS NULL AND ${q.flag} = ANY(v.data_flags)))`);
  }

  const outer: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (q.stock === 'in') outer.push(Prisma.sql`available_qty > 0`);
  if (q.stock === 'out') outer.push(Prisma.sql`available_qty = 0`);
  if (q.stock === 'low') outer.push(Prisma.sql`low_stock`);
  if (q.stock === 'oversold') outer.push(Prisma.sql`oversold`);
  if (q.readiness === 'ready') outer.push(Prisma.sql`cardinality(failures) = 0`);
  else if (q.readiness === 'blocked') outer.push(Prisma.sql`cardinality(failures) > 0`);
  else if (q.readiness) outer.push(Prisma.sql`${q.readiness} = ANY(failures)`);
  if (q.imageState === 'missing') outer.push(Prisma.sql`cover_status IS NULL`);
  if (q.imageState === 'ready') outer.push(Prisma.sql`cover_status = 'READY'`);
  if (q.imageState === 'failed') outer.push(Prisma.sql`cover_status IN ('FAILED', 'REJECTED')`);
  if (q.imageState === 'processing') outer.push(Prisma.sql`cover_status IN ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING')`);

  const order = {
    updated_desc: Prisma.sql`updated_at DESC, id DESC`,
    name: Prisma.sql`lower(name), id`,
    price: Prisma.sql`min_price ASC NULLS LAST, id`,
    stock: Prisma.sql`available_qty ASC, id`,
  }[q.sort];

  const base = Prisma.sql`
      SELECT p.id, p.name, p.slug, p.status, p.type_id, t.name AS type_name, p.category_id, c.name AS category_name,
             product_readiness_failures(p) AS failures, cover.media_id AS cover_media_id, cover.status AS cover_status,
             (SELECT count(*)::int FROM product_variants v WHERE v.product_id = p.id AND v.deleted_at IS NULL) AS variant_count,
             p.active_variant_count, p.min_price, p.max_price, p.available_qty,
             EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.is_active
                       AND v.on_hand - v.reserved > 0 AND v.on_hand - v.reserved <= v.low_stock_threshold) AS low_stock,
             EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.on_hand < v.reserved) AS oversold,
             ARRAY(SELECT DISTINCT f FROM (SELECT unnest(p.data_flags) AS f UNION ALL
                     SELECT unnest(v.data_flags) FROM product_variants v WHERE v.product_id = p.id AND v.deleted_at IS NULL) x ORDER BY f) AS flags,
             (p.status = 'DRAFT' AND p.import_key IS NULL
               AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = p.id)
               AND NOT EXISTS (SELECT 1 FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id WHERE v.product_id = p.id)
               AND NOT EXISTS (SELECT 1 FROM product_import_rows r WHERE r.product_id = p.id)
               AND NOT EXISTS (SELECT 1 FROM inventory_movements m JOIN product_variants v ON v.id = m.variant_id WHERE v.product_id = p.id)
               AND NOT EXISTS (SELECT 1 FROM inventory_reservations r JOIN product_variants v ON v.id = r.variant_id WHERE v.product_id = p.id)) AS deletable,
             p.updated_at, p.version
        FROM products p
        LEFT JOIN product_types t ON t.id = p.type_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN LATERAL (SELECT m.id AS media_id, m.status::text AS status FROM product_images pi JOIN media m ON m.id = pi.media_id
                            WHERE pi.product_id = p.id AND pi.is_cover AND m.deleted_at IS NULL LIMIT 1) cover ON TRUE
       WHERE ${Prisma.join(where, ' AND ')}
`;
  const filtered = Prisma.sql`WITH base AS (${base}) SELECT * FROM base WHERE ${Prisma.join(outer, ' AND ')}`;
  const [rows, [count]] = await Promise.all([
    prisma.$queryRaw<Row[]>`${filtered} ORDER BY ${order} LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (${filtered}) f`,
  ]);
  const total = Number(count!.n);

  // Cover URLs come from the media service (public CDN renditions); only READY covers have them.
  const ready = rows.filter((r) => r.cover_status === 'READY' && r.cover_media_id !== null).map((r) => r.cover_media_id!);
  const media = new Map((await prisma.media.findMany({ where: { id: { in: ready } } })).map((m) => [m.id, renderMedia(m).renditions ?? {}]));
  const data: ProductListRow[] = rows.map((r, i) => {
    const renditions = r.cover_media_id !== null ? media.get(r.cover_media_id) : undefined;
    return {
      serial: (q.page - 1) * q.limit + i + 1, id: r.id, name: r.name, slug: r.slug,
      image: { state: imageState(r.cover_status), url: renditions ? (renditions['160'] ?? Object.values(renditions)[0] ?? null) : null },
      type: r.type_id === null ? null : { id: r.type_id, name: r.type_name! },
      category: r.category_id === null ? null : { id: r.category_id, name: r.category_name! },
      status: r.status, isPublishable: r.failures.length === 0, readinessFailures: r.failures,
      variantCount: r.variant_count, activeVariantCount: r.active_variant_count,
      priceRange: r.min_price === null || r.max_price === null ? null : { min: r.min_price, max: r.max_price },
      available: r.available_qty, lowStock: r.low_stock, oversold: r.oversold, flags: r.flags, deletable: r.deletable,
      updatedAt: r.updated_at.toISOString(), version: r.version,
    };
  });
  return { data, meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
}
