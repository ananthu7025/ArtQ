// Task 3.5: GET /v1/products and the listing headers (api.md §3.3, product.md §5.2, architecture.md §6.2).
// ✅ A product with gold out of stock + silver in stock does not match "Gold + in stock".
import { PUBLIC_CACHE_CONTROL, type ProductList } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { prefixQuery } from '../../src/storefront/listing.js';
import { storefrontRouter } from '../../src/storefront/routes.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { order, uniq } from '../helpers/fixtures.js';
import { startPostgres, type Service } from '../helpers/services.js';
import { liveProduct, readyImage, type LiveProduct } from '../helpers/storefront-fixtures.js';

const CDN = (key: string) => `https://cdn.test/${key}`;
let pg: Service, db: TestDb, prisma: PrismaClient, app: Express;
beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  app = createApp({ version: 't', origins: { storefront: ['http://localhost:3000'], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} }, routes: [storefrontRouter({ prisma, mediaUrl: CDN })] });
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });

async function wipe() {
  for (const t of ['order_items', 'inventory_reservations', 'orders', 'product_techniques', 'techniques', 'product_images', 'stock_notifications', 'product_variants', 'products', 'categories', 'slug_redirects', 'product_types']) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${t}`);
  }
}
const list = async (qs = '') => { const res = await request(app).get(`/v1/products${qs ? `?${qs}` : ''}`); expect(res.status, JSON.stringify(res.body)).toBe(200); return res.body as ProductList; };
const names = (l: ProductList) => l.data.map((c) => c.name);

describe('✅ same-variant filters', () => {
  let pigment: LiveProduct, frame: LiveProduct;
  beforeAll(async () => {
    await wipe();
    // Gold sold out, Silver in stock; both 20 gm. A frame with no colours.
    pigment = await liveProduct(prisma, { name: 'Mica Pigment', variants: [
      { price: 19_000, size: '20 gm', color: 'Gold', colorHex: '#D4AF37', onHand: 0 },
      { price: 21_000, mrp: 30_000, size: '20 gm', color: 'Silver', colorHex: '#C0C0C0', onHand: 8 },
      { price: 49_000, size: '50 gm', color: 'Gold', colorHex: '#D4AF37', onHand: 4 },
    ] });
    frame = await liveProduct(prisma, { name: 'Teak Frame', variants: [{ price: 89_900, size: '8x10 in', onHand: 3 }] });
  });

  it('Gold + in stock does not match on the gold 20 gm being sold out… unless another gold size is in stock', async () => {
    expect(names(await list('color=Gold&inStock=1&size=20%20gm'))).toEqual([]);           // the gold 20 gm is sold out
    expect(names(await list('color=Silver&inStock=1&size=20%20gm'))).toEqual(['Mica Pigment']);
    expect(names(await list('color=Gold&inStock=1'))).toEqual(['Mica Pigment']);          // via the 50 gm gold
    expect(names(await list('color=Gold&size=20%20gm'))).toEqual(['Mica Pigment']);       // without "in stock"
  });

  it('the card shows the cheapest MATCHING variant (price, MRP, discount); price sorting uses it', async () => {
    const silver = (await list('color=Silver')).data[0]!;
    expect(silver).toMatchObject({ fromPrice: 21_000, maxPrice: 21_000, mrp: 30_000, discountPercent: 30 });
    const gold = (await list('color=Gold&inStock=1')).data[0]!;
    expect(gold).toMatchObject({ fromPrice: 49_000, mrp: null });
    expect((await list()).data.find((c) => c.id === pigment.productId)).toMatchObject({ fromPrice: 19_000, maxPrice: 49_000 });
    expect(names(await list('sort=price_asc'))).toEqual(['Mica Pigment', 'Teak Frame']);
    expect(names(await list('sort=price_asc&size=50%20gm&size=8x10%20in'))).toEqual(['Mica Pigment', 'Teak Frame']);
    expect(names(await list('sort=price_desc&minPrice=40000'))).toEqual(['Teak Frame', 'Mica Pigment']);   // 49,000 vs 89,900
  });

  it('on sale = a matching variant with MRP above price; a price range is per variant', async () => {
    expect(names(await list('sale=1'))).toEqual(['Mica Pigment']);
    expect(names(await list('sale=1&color=Gold'))).toEqual([]);                            // only the silver is on sale
    expect(names(await list('minPrice=20000&maxPrice=30000'))).toEqual(['Mica Pigment']);  // the 21,000 silver
    expect(names(await list('minPrice=20000&maxPrice=30000&color=Gold'))).toEqual([]);
    expect(names(await list('minPrice=89900&maxPrice=89900'))).toEqual(['Teak Frame']);    // exactly at both limits
  });

  it('facets: each dimension counts with every OTHER filter applied, by the same rule', async () => {
    const f = (await list('color=Gold&inStock=1')).facets;
    expect(f.sizes).toEqual([{ value: '50 gm', label: '50 gm', count: 1 }]);              // gold + in stock → only the 50 gm
    expect(f.colors).toEqual([{ value: 'Gold', label: 'Gold', count: 1, hex: '#D4AF37' }, { value: 'Silver', label: 'Silver', count: 1, hex: '#C0C0C0' }]);
    expect(f.price).toEqual({ min: 49_000, max: 49_000 });
    const all = (await list()).facets;
    expect(all.sizes.map((s) => [s.value, s.count]).sort()).toEqual([['20 gm', 1], ['50 gm', 1], ['8x10 in', 1]]);
    const grams = all.sizes.map((s) => s.value).filter((v) => v.endsWith('gm'));
    expect(grams).toEqual(['20 gm', '50 gm']);   // same unit: by amount, not alphabetically
    expect(all.price).toEqual({ min: 19_000, max: 89_900 });
    // A selected value that matches nothing is still listed (count 0) so it can be removed.
    expect((await list('size=999%20gm')).facets.sizes).toContainEqual({ value: '999 gm', label: '999 gm', count: 0 });
    expect(frame.productId).toBeGreaterThan(0);
  });
});

describe('taxonomy, flags, search, sorting, paging', () => {
  let resin: { typeId: number; categoryId: number }, frames: { typeId: number; categoryId: number };
  beforeAll(async () => {
    await wipe();
    const typeR = await prisma.productType.create({ data: { name: 'Resins', slug: 'resins', sortOrder: 1 } });
    const typeF = await prisma.productType.create({ data: { name: 'Frames', slug: 'frames', sortOrder: 2 } });
    const art = await prisma.category.create({ data: { typeId: typeR.id, name: 'Art Resin', slug: 'art-resin' } });
    const teak = await prisma.category.create({ data: { typeId: typeF.id, name: 'Teak Frames', slug: 'teak-frames' } });
    resin = { typeId: typeR.id, categoryId: art.id }; frames = { typeId: typeF.id, categoryId: teak.id };
    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    const a = await liveProduct(prisma, { ...resin, name: 'Ultra Clear Epoxy', variants: [{ price: 99_900 }], publishedAt: day(1), isNewArrival: true });
    const b = await liveProduct(prisma, { ...resin, name: 'Deep Pour Resin', variants: [{ price: 1_49_900 }], publishedAt: day(3), isTrending: true });
    const c = await liveProduct(prisma, { ...frames, name: 'teak square frame', variants: [{ price: 49_900 }], publishedAt: day(2) });
    await liveProduct(prisma, { ...resin, name: 'Hidden Draft Resin', status: 'DRAFT' });
    await prisma.product.update({ where: { id: c.productId }, data: { isFeatured: true } });
    const coasters = await prisma.technique.create({ data: { name: 'Coasters', slug: 'coasters' } });
    await prisma.productTechnique.createMany({ data: [{ productId: a.productId, techniqueId: coasters.id }, { productId: c.productId, techniqueId: coasters.id }] });
    // Sales: Deep Pour sold 3 (paid), Ultra Clear 1 (paid) + 5 unpaid (not counted).
    for (const [variantId, qty, paid] of [[b.variantIds[0]!, 3, true], [a.variantIds[0]!, 1, true], [a.variantIds[0]!, 5, false]] as const) {
      const o = await order(prisma, { lines: [{ variantId, qty }], reserve: false });
      if (paid) await prisma.$executeRawUnsafe(`UPDATE orders SET payment_status = 'PAID' WHERE id = $1`, o.orderId);
    }
  });

  it('only ACTIVE products; type, category and technique filters (lists are OR within, AND across); flags', async () => {
    expect(names(await list('sort=name_asc'))).toEqual(['Deep Pour Resin', 'teak square frame', 'Ultra Clear Epoxy']);
    expect(names(await list('type=resins&sort=name_asc'))).toEqual(['Deep Pour Resin', 'Ultra Clear Epoxy']);
    expect(names(await list('type=resins&type=frames'))).toHaveLength(3);
    expect(names(await list('category=teak-frames'))).toEqual(['teak square frame']);
    expect(names(await list('technique=coasters&type=frames'))).toEqual(['teak square frame']);
    expect(names(await list('isNew=1'))).toEqual(['Ultra Clear Epoxy']);
    expect(names(await list('isTrending=true'))).toEqual(['Deep Pour Resin']);
    expect(names(await list('type=no-such-type'))).toEqual([]);
  });

  it('taxonomy facets count with the other filters; categories follow the chosen type', async () => {
    const f = (await list('type=resins')).facets;
    expect(f.types).toEqual([{ value: 'resins', label: 'Resins', count: 2 }, { value: 'frames', label: 'Frames', count: 1 }]);   // its own dimension ignored
    expect(f.categories).toEqual([{ value: 'art-resin', label: 'Art Resin', count: 2 }]);
    expect(f.techniques).toEqual([{ value: 'coasters', label: 'Coasters', count: 1 }]);
    expect((await list('type=frames&size=nothing')).facets.types).toContainEqual({ value: 'frames', label: 'Frames', count: 0 });   // real name, not the slug
  });

  it('sorts: featured (default), newest, name, price, best selling (paid orders only)', async () => {
    expect(names(await list())[0]).toBe('teak square frame');
    expect(names(await list('sort=newest'))).toEqual(['Deep Pour Resin', 'teak square frame', 'Ultra Clear Epoxy']);
    expect(names(await list('sort=name_asc'))).toEqual(['Deep Pour Resin', 'teak square frame', 'Ultra Clear Epoxy']);   // case-insensitive
    expect(names(await list('sort=price_desc'))).toEqual(['Deep Pour Resin', 'Ultra Clear Epoxy', 'teak square frame']);
    expect(names(await list('sort=best_selling'))).toEqual(['Deep Pour Resin', 'Ultra Clear Epoxy', 'teak square frame']);
  });

  it('search: word prefixes, any case/accents; relevance is the default sort with a search; ILIKE fallback for symbols', async () => {
    expect(names(await list('q=deep%20po'))).toEqual(['Deep Pour Resin']);
    expect(names(await list('q=TEAK'))).toEqual(['teak square frame']);
    expect(names(await list('q=res'))).toEqual(expect.arrayContaining(['Deep Pour Resin', 'Ultra Clear Epoxy']));
    expect(names(await list('q=zzzz'))).toEqual([]);
    expect(names(await list('q=%25%25'))).toEqual([]);   // only symbols: no error, nothing matches "%%" literally
    expect(prefixQuery('Mica  Gold!')).toBe('mica:* & gold:*');
    expect(prefixQuery('Pâte')).toBe('pate:*');
    expect(prefixQuery('***')).toBeNull();
  });

  it('paging: limit/page, total and totalPages; past the end → empty data, same total', async () => {
    const p1 = await list('limit=2&sort=name_asc');
    expect(p1.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(names(p1)).toEqual(['Deep Pour Resin', 'teak square frame']);
    expect(names(await list('limit=2&page=2&sort=name_asc'))).toEqual(['Ultra Clear Epoxy']);
    expect(await list('limit=2&page=9')).toMatchObject({ data: [], meta: { total: 3, totalPages: 2 } });
  });

  it('publicly cacheable', async () => {
    expect((await request(app).get('/v1/products')).headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
  });

  it('invalid parameters → 400 with field messages', async () => {
    const bad = async (qs: string, path: string, message?: string) => {
      const res = await request(app).get(`/v1/products?${qs}`);
      expect(res.status, qs).toBe(400);
      expect(res.body.error.details.some((d: { path: string; message: string }) => d.path === path && (!message || d.message === message)), JSON.stringify(res.body.error.details)).toBe(true);
    };
    await bad('minPrice=500&maxPrice=100', 'maxPrice', 'The maximum must be at least the minimum');
    await bad('sort=relevance', 'sort', 'Relevance needs a search');
    await bad('sort=cheapest', 'sort');
    await bad('minPrice=-1', 'minPrice', 'Use 0 or more');
    await bad('minPrice=abc', 'minPrice');
    await bad('limit=97', 'limit');
    await bad('page=0', 'page');
    await bad(Array.from({ length: 21 }, (_, i) => `size=s${i}`).join('&'), 'size', 'Choose at most 20');
    await bad(`q=${'x'.repeat(101)}`, 'q', 'Use at most 100 characters');
    await bad('utm_source=x', '');
    expect((await request(app).get(`/v1/products?q=${'x'.repeat(100)}&limit=96&page=200`)).status).toBe(200);   // limits are inclusive
  });

  it('listing headers: type with its categories (that have live products), category with its type, technique; old slugs redirect; inactive → 404', async () => {
    const banner = await readyImage(prisma);
    await prisma.productType.update({ where: { id: resin.typeId }, data: { description: 'Epoxy and UV resins.', bannerMediaId: banner, metaTitle: 'Resins | ArtQ' } });
    await prisma.category.create({ data: { typeId: resin.typeId, name: 'Empty Category', slug: `empty-${uniq()}` } });
    const t = await request(app).get('/v1/types/resins');
    expect(t.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
    expect(t.body).toMatchObject({ kind: 'type', name: 'Resins', description: 'Epoxy and UV resins.', metaTitle: 'Resins | ArtQ', parent: null, children: [{ slug: 'art-resin', name: 'Art Resin' }] });
    expect(t.body.banner.id).toBe(banner);
    expect((await request(app).get('/v1/categories/teak-frames')).body).toMatchObject({ kind: 'category', name: 'Teak Frames', parent: { slug: 'frames', name: 'Frames' } });
    expect((await request(app).get('/v1/techniques/coasters')).body).toMatchObject({ kind: 'technique', name: 'Coasters' });
    await prisma.slugRedirect.create({ data: { entity: 'type', oldSlug: 'old-resins', newSlug: 'resins' } });
    expect((await request(app).get('/v1/types/old-resins')).body).toEqual({ redirectTo: 'resins' });
    await prisma.productType.update({ where: { id: frames.typeId }, data: { isActive: false } });
    expect((await request(app).get('/v1/types/frames')).status).toBe(404);
    expect((await request(app).get('/v1/categories/teak-frames')).status).toBe(404);    // its type is off
    expect((await request(app).get('/v1/techniques/nope')).status).toBe(404);
    await prisma.productType.update({ where: { id: frames.typeId }, data: { isActive: true } });
  });
});
