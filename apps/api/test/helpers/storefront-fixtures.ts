// Storefront test data: products that really pass the publication gate (product.md §8.7, enforced by the database
// trigger), public media in its READY state, and the content tables the home page reads.
import type { PrismaClient } from '@prisma/client';
import * as fn from '../../src/db/functions.js';
import { uniq, val } from './fixtures.js';

/** A READY public image with WebP renditions (keys only; URLs are built by the API). */
export async function readyImage(db: PrismaClient, o: { status?: string; visibility?: string; width?: number; height?: number } = {}): Promise<number> {
  const key = `public/test/${uniq()}`;
  return val<number>(db, `INSERT INTO media (key, visibility, kind, declared_mime, detected_mime, declared_size, size_bytes, width, height, renditions, placeholder, owner_scope, status, updated_at)
    VALUES ($1, $2::"MediaVisibility", 'IMAGE', 'image/jpeg', 'image/jpeg', 1000, 1000, $3, $4, $5::jsonb, 'data:image/webp;base64,AAAA', 'product', $6::"MediaStatus", now()) RETURNING id`,
  `${key}.jpg`, o.visibility ?? 'PUBLIC', o.width ?? 1200, o.height ?? 1200,
  JSON.stringify({ 320: `${key}/w320.webp`, 640: `${key}/w640.webp`, 1200: `${key}/w1200.webp` }), o.status ?? 'READY');
}

/** A READY public video (hero, reels). */
export async function readyVideo(db: PrismaClient, status = 'READY'): Promise<number> {
  return val<number>(db, `INSERT INTO media (key, visibility, kind, declared_mime, detected_mime, declared_size, size_bytes, owner_scope, status, updated_at)
    VALUES ($1, 'PUBLIC', 'VIDEO', 'video/mp4', 'video/mp4', 5000, 5000, 'content', $2::"MediaStatus", now()) RETURNING id`, `public/test/${uniq()}.mp4`, status);
}

export type LiveProduct = { productId: number; slug: string; name: string; variantIds: number[]; typeId: number; categoryId: number };

/**
 * A product that passes every publication check, then published (status ACTIVE). Variants: price (paise), optional MRP,
 * stock (counted). `status: 'DRAFT'` leaves it unpublished but otherwise ready.
 */
export async function liveProduct(db: PrismaClient, o: {
  typeId?: number; categoryId?: number; name?: string; variants?: { price: number; mrp?: number | null; onHand?: number; active?: boolean }[];
  images?: number; status?: 'ACTIVE' | 'DRAFT'; isNewArrival?: boolean; newArrivalRank?: number | null; isTrending?: boolean; trendingRank?: number | null; publishedAt?: Date;
} = {}): Promise<LiveProduct> {
  const u = uniq();
  const typeId = o.typeId ?? await val<number>(db, `INSERT INTO product_types (name, slug, updated_at) VALUES ($1,$1,now()) RETURNING id`, `type-${u}`);
  const categoryId = o.categoryId ?? await val<number>(db, `INSERT INTO categories (type_id, name, slug, updated_at) VALUES ($1,$2,$2,now()) RETURNING id`, typeId, `cat-${u}`);
  const name = o.name ?? `Product ${u}`;
  const slug = `product-${u}`;
  const productId = await val<number>(db, `INSERT INTO products (type_id, category_id, name, slug, description, hsn_code, gst_rate, tax_approved_at,
      is_new_arrival, new_arrival_rank, is_trending, trending_rank, updated_at)
    VALUES ($1,$2,$3,$4,'A real description.','3907',18,now(),$5,$6,$7,$8,now()) RETURNING id`,
  typeId, categoryId, name, slug, o.isNewArrival ?? false, o.newArrivalRank ?? null, o.isTrending ?? false, o.trendingRank ?? null);
  const variantIds: number[] = [];
  for (const [i, v] of (o.variants ?? [{ price: 49_900 }]).entries()) {
    variantIds.push(await val<number>(db, `INSERT INTO product_variants (product_id, sku, size, label, price, mrp, on_hand, inventory_counted_at, net_quantity, net_unit,
        weight_g, weight_source, is_active, updated_at)
      VALUES ($1,$2,$3,$3,$4,$5,$6,now(),$7,'G',300,'MEASURED',$8,now()) RETURNING id`,
    productId, `SKU-${u}-${i}`, `${(i + 1) * 100} gm`, v.price, v.mrp ?? null, v.onHand ?? 10, (i + 1) * 100, v.active ?? true));
  }
  for (let i = 0; i < (o.images ?? 1); i++) {
    await db.$executeRawUnsafe(`INSERT INTO product_images (product_id, media_id, alt, sort_order, is_cover) VALUES ($1,$2,$3,$4,$5)`, productId, await readyImage(db), `${name} photo ${i + 1}`, i, i === 0);
  }
  await fn.refreshProducts(db, [productId]);
  await db.$executeRawUnsafe(`UPDATE products SET is_publishable = true WHERE id = $1`, productId);
  if ((o.status ?? 'ACTIVE') === 'ACTIVE') {
    await db.$executeRawUnsafe(`UPDATE products SET status = 'ACTIVE', published_at = $2 WHERE id = $1`, productId, o.publishedAt ?? new Date());
  }
  return { productId, slug, name, variantIds, typeId, categoryId };
}
