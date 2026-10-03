// Task 3.3: GET /v1/home (api.md §3.1, product.md §5.1). Real PostgreSQL; every product here passes the real
// publication gate (database trigger), so "only ACTIVE products" is tested against what admins can actually publish.
import { DEFAULT_SETTINGS, type HomeView } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { storefrontRouter } from '../../src/storefront/routes.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq, val } from '../helpers/fixtures.js';
import { startPostgres, type Service } from '../helpers/services.js';
import { liveProduct, readyImage, readyVideo } from '../helpers/storefront-fixtures.js';

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
  for (const t of ['reels', 'testimonials', 'home_slides', 'product_techniques', 'techniques', 'product_images', 'product_variants', 'products', 'categories', 'product_types', 'settings']) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${t}`);
  }
}
const home = async () => { const res = await request(app).get('/v1/home'); expect(res.status).toBe(200); return res.body as HomeView; };
const setSetting = (key: string, value: unknown) => prisma.setting.upsert({ where: { key }, create: { key, value: value as object, isPublic: true }, update: { value: value as object, isPublic: true } });

describe('GET /v1/home', () => {
  beforeEach(wipe);

  it('an empty store: only the (fallback) hero; nothing else is listed as a section; publicly cacheable', async () => {
    const res = await request(app).get('/v1/home');
    expect(res.body).toEqual({ sections: ['hero'], hero: { slides: [], intervalMs: 6000 }, types: [], newArrivals: [], trending: [], reels: [], techniques: [], testimonials: [], instagram: { handle: null, url: null } });
    expect(res.headers['cache-control']).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=60');
  });

  it('product cards: only ACTIVE products; from-price, MRP and discount of the cheapest variant; stock; one-variant default; cover then hover image', async () => {
    const a = await liveProduct(prisma, { name: 'Ultra Clear Epoxy', variants: [{ price: 99_900, mrp: 1_20_000 }, { price: 49_900, mrp: 59_900 }, { price: 1_99_900 }], images: 2 });
    const single = await liveProduct(prisma, { name: 'Mica Gold', variants: [{ price: 19_000, onHand: 0 }] });
    await liveProduct(prisma, { name: 'Draft Thing', status: 'DRAFT' });
    const withInactive = await liveProduct(prisma, { name: 'Two Sizes', variants: [{ price: 30_000 }, { price: 10_000, active: false }] });
    const { newArrivals } = await home();
    expect(newArrivals.map((c) => c.name).sort()).toEqual(['Mica Gold', 'Two Sizes', 'Ultra Clear Epoxy']);
    const card = newArrivals.find((c) => c.id === a.productId)!;
    expect(card).toMatchObject({ slug: a.slug, fromPrice: 49_900, maxPrice: 1_99_900, mrp: 59_900, discountPercent: 17, inStock: true, variantCount: 3, defaultVariantId: null, isNew: false });
    expect(card.image).toMatchObject({ alt: 'Ultra Clear Epoxy photo 1', width: 1200, height: 1200 });
    expect(card.image!.url).toMatch(/^https:\/\/cdn\.test\/public\/test\/.+\/w640\.webp$/);
    expect(card.image!.srcset.webp.split(', ')).toHaveLength(3);
    expect(card.hoverImage!.alt).toBe('Ultra Clear Epoxy photo 2');
    expect(newArrivals.find((c) => c.id === single.productId)).toMatchObject({ inStock: false, variantCount: 1, defaultVariantId: single.variantIds[0], mrp: null, discountPercent: null, hoverImage: null });
    expect(newArrivals.find((c) => c.id === withInactive.productId)).toMatchObject({ fromPrice: 30_000, variantCount: 1, defaultVariantId: withInactive.variantIds[0] });   // the inactive cheaper size is ignored
  });

  it('an image that is not READY, or not public, is never returned (card shows the placeholder)', async () => {
    const p = await liveProduct(prisma, { name: 'Image Check', images: 2 });
    const imgs = await prisma.productImage.findMany({ where: { productId: p.productId }, orderBy: { sortOrder: 'asc' } });
    await prisma.media.update({ where: { id: imgs[1]!.mediaId }, data: { status: 'PROCESSING' } });
    expect((await home()).newArrivals[0]!.hoverImage).toBeNull();
    await prisma.media.update({ where: { id: imgs[0]!.mediaId }, data: { visibility: 'PRIVATE' } });
    expect((await home()).newArrivals[0]!.image).toBeNull();
  });

  it('New Arrivals: flagged ones by rank first, then the most recently published; at most 8', async () => {
    const t = await liveProduct(prisma, { name: 'seed' });
    const old = new Date('2026-01-01');
    for (let i = 0; i < 9; i++) await liveProduct(prisma, { typeId: t.typeId, categoryId: t.categoryId, name: `Plain ${i}`, publishedAt: new Date(old.getTime() + i * 86_400_000) });
    await liveProduct(prisma, { typeId: t.typeId, categoryId: t.categoryId, name: 'New B', isNewArrival: true, newArrivalRank: 2, publishedAt: old });
    await liveProduct(prisma, { typeId: t.typeId, categoryId: t.categoryId, name: 'New A', isNewArrival: true, newArrivalRank: 1, publishedAt: old });
    await liveProduct(prisma, { typeId: t.typeId, categoryId: t.categoryId, name: 'New unranked', isNewArrival: true, publishedAt: old });
    const names = (await home()).newArrivals.map((c) => c.name);
    expect(names).toHaveLength(8);
    expect(names.slice(0, 3)).toEqual(['New A', 'New B', 'New unranked']);
    expect(names[3]).toBe('seed');                                   // published now: the newest of the rest
    expect(names.slice(4)).toEqual(['Plain 8', 'Plain 7', 'Plain 6', 'Plain 5']);
    expect((await home()).newArrivals[0]!.isNew).toBe(true);
  });

  it('Trending now: reels when there are any; otherwise the trending products (by rank) as the fallback grid', async () => {
    const t1 = await liveProduct(prisma, { name: 'Trend 2', isTrending: true, trendingRank: 2 });
    await liveProduct(prisma, { typeId: t1.typeId, categoryId: t1.categoryId, name: 'Trend 1', isTrending: true, trendingRank: 1 });
    await liveProduct(prisma, { typeId: t1.typeId, categoryId: t1.categoryId, name: 'Not trending' });
    let h = await home();
    expect(h.trending.map((c) => c.name)).toEqual(['Trend 1', 'Trend 2']);
    expect(h.sections).toContain('trending');
    expect(h.sections).not.toContain('reels');
    const draft = await liveProduct(prisma, { name: 'Draft linked', status: 'DRAFT' });
    await prisma.reel.create({ data: { title: 'Pouring a coaster', videoMediaId: await readyVideo(prisma), thumbnailMediaId: await readyImage(prisma), productId: t1.productId } });
    await prisma.reel.create({ data: { title: 'Linked to a draft', videoMediaId: await readyVideo(prisma), productId: draft.productId } });
    await prisma.reel.create({ data: { title: 'Still processing', videoMediaId: await readyVideo(prisma, 'PROCESSING') } });
    await prisma.reel.create({ data: { title: 'Switched off', videoMediaId: await readyVideo(prisma), isActive: false } });
    h = await home();
    expect(h.reels.map((r) => r.title)).toEqual(['Pouring a coaster', 'Linked to a draft']);
    expect(h.reels[0]).toMatchObject({ product: { slug: t1.slug, name: 'Trend 2' }, video: { mime: 'video/mp4' } });
    expect(h.reels[0]!.video.url).toMatch(/^https:\/\/cdn\.test\/public\/test\/.+\.mp4$/);
    expect(h.reels[0]!.poster).not.toBeNull();
    expect(h.reels[1]!.product).toBeNull();                         // never a link to an unpublished product
    expect(h.sections).toContain('reels');
    expect(h.sections).not.toContain('trending');
  });

  it('range circles: active types marked "show on home", in order, with tile link overrides and READY images only', async () => {
    const img = await readyImage(prisma);
    await prisma.productType.create({ data: { name: 'Pigments', slug: `pig-${uniq()}`, sortOrder: 2, imageMediaId: img } });
    await prisma.productType.create({ data: { name: 'Resins', slug: `res-${uniq()}`, sortOrder: 1, imageMediaId: await readyImage(prisma, { status: 'REJECTED' }) } });
    await prisma.productType.create({ data: { name: 'UV Resin', slug: `uv-${uniq()}`, sortOrder: 3, tileLinkUrl: '/category/uv-resin' } });
    await prisma.productType.create({ data: { name: 'Hidden', slug: `hid-${uniq()}`, showOnHome: false } });
    await prisma.productType.create({ data: { name: 'Off', slug: `off-${uniq()}`, isActive: false } });
    const { types, sections } = await home();
    expect(types.map((t) => t.name)).toEqual(['Resins', 'Pigments', 'UV Resin']);
    expect(types[0]!.image).toBeNull();
    expect(types[1]!.image!.id).toBe(img);
    expect(types[2]!.href).toBe('/category/uv-resin');
    expect(sections).toEqual(['hero', 'types']);
  });

  it('techniques only when they have something to buy; testimonials (rating 1–5, product link only if live)', async () => {
    const p = await liveProduct(prisma, { name: 'Coaster Mould' });
    const used = await prisma.technique.create({ data: { name: 'Coasters', slug: `coasters-${uniq()}`, imageMediaId: await readyImage(prisma) } });
    await prisma.technique.create({ data: { name: 'Nothing live', slug: `none-${uniq()}` } });
    await prisma.productTechnique.create({ data: { productId: p.productId, techniqueId: used.id } });
    await prisma.testimonial.create({ data: { name: 'Anu', location: 'Kochi', quote: 'Crystal clear.', rating: 5, productId: p.productId, sortOrder: 1 } });
    await prisma.testimonial.create({ data: { name: 'Ravi', quote: 'Fast shipping.', rating: 1, sortOrder: 2 } });
    await prisma.testimonial.create({ data: { name: 'Hidden', quote: 'x', rating: 3, isActive: false } });
    const h = await home();
    expect(h.techniques.map((t) => t.name)).toEqual(['Coasters']);
    expect(h.testimonials).toEqual([
      { id: expect.any(Number), name: 'Anu', location: 'Kochi', quote: 'Crystal clear.', rating: 5, avatar: null, product: { slug: p.slug, name: 'Coaster Mould' } },
      { id: expect.any(Number), name: 'Ravi', location: null, quote: 'Fast shipping.', rating: 1, avatar: null, product: null },
    ]);
  });

  it('hero: active slides in their date window; a video slide uses its second image as poster; slides without usable media are dropped', async () => {
    const day = 86_400_000;
    const img = await readyImage(prisma);
    await prisma.homeSlide.create({ data: { heading: 'Video', mediaId: await readyVideo(prisma), mobileMediaId: img, sortOrder: 1 } });
    await prisma.homeSlide.create({ data: { heading: 'Image', subheading: 'Sub', ctaText: 'Shop', ctaLink: '/shop', mediaId: await readyImage(prisma), sortOrder: 2 } });
    await prisma.homeSlide.create({ data: { heading: 'Future', mediaId: await readyImage(prisma), startsAt: new Date(Date.now() + day) } });
    await prisma.homeSlide.create({ data: { heading: 'Expired', mediaId: await readyImage(prisma), endsAt: new Date(Date.now() - day) } });
    await prisma.homeSlide.create({ data: { heading: 'Broken', mediaId: await readyImage(prisma, { status: 'FAILED' }) } });
    await prisma.homeSlide.create({ data: { heading: 'Off', mediaId: await readyImage(prisma), isActive: false } });
    await setSetting('HERO', { slideIntervalMs: 8000 });
    const { hero } = await home();
    expect(hero.intervalMs).toBe(8000);
    expect(hero.slides.map((s) => s.heading)).toEqual(['Video', 'Image']);
    expect(hero.slides[0]).toMatchObject({ video: { mime: 'video/mp4' }, image: { id: img }, mobileImage: null });
    expect(hero.slides[1]).toMatchObject({ video: null, subheading: 'Sub', ctaText: 'Shop', ctaLink: '/shop' });
  });

  it('section order and switches come from HOME_SECTIONS; hidden, unknown and empty sections are left out; Instagram when enabled', async () => {
    const p = await liveProduct(prisma, { name: 'Any', isTrending: true });
    await prisma.productType.update({ where: { id: p.typeId }, data: { showOnHome: true } });
    await prisma.testimonial.create({ data: { name: 'Anu', quote: 'Lovely', rating: 5 } });
    await setSetting('HOME_SECTIONS', { order: ['testimonials', 'hero', 'bogus', 'new-arrivals', 'types', 'trending', 'reels', 'instagram'], hidden: ['types'] });
    await setSetting('INSTAGRAM_MOMENTS', { enabled: true, handle: '@artq.in' });
    await setSetting('SOCIAL', { ...DEFAULT_SETTINGS.SOCIAL, instagram: null });
    const h = await home();
    expect(h.sections).toEqual(['testimonials', 'hero', 'new-arrivals', 'trending', 'instagram']);
    expect(h.instagram).toEqual({ handle: 'artq.in', url: 'https://www.instagram.com/artq.in' });
    await setSetting('INSTAGRAM_MOMENTS', { enabled: false, handle: '@artq.in' });
    expect((await home()).sections).not.toContain('instagram');
  });

  it('a broken stored HOME_SECTIONS value falls back to the default order', async () => {
    await liveProduct(prisma, { name: 'Any' });
    await setSetting('HOME_SECTIONS', { order: 'not-a-list' });
    expect((await home()).sections).toEqual(['hero', 'types', 'new-arrivals']);   // product.md §5.1 default order
  });

  it('an archived or deleted product disappears from the home page at once (no stale card from the API)', async () => {
    const p = await liveProduct(prisma, { name: 'Going away' });
    expect((await home()).newArrivals).toHaveLength(1);
    await prisma.$executeRawUnsafe(`UPDATE products SET status = 'ARCHIVED' WHERE id = $1`, p.productId);
    expect((await home()).newArrivals).toHaveLength(0);
    expect(await val<number>(prisma, `SELECT count(*)::int FROM products WHERE id = $1`, p.productId)).toBe(1);
  });
});
