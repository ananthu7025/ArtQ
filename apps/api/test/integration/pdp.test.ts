// Task 3.6: the product page's data — detail sections, related products, cards by id (recently viewed) and the
// pincode check (api.md §3.2, §3.3; product.md §5.3; database.md §3.2 resolution order).
import { DEFAULT_SETTINGS, NO_STORE, PUBLIC_CACHE_CONTROL } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { storefrontRouter } from '../../src/storefront/routes.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { order, val } from '../helpers/fixtures.js';
import { startPostgres, type Service } from '../helpers/services.js';
import { liveProduct, readyVideo, type LiveProduct } from '../helpers/storefront-fixtures.js';

const CDN = (key: string) => `https://cdn.test/${key}`;
let pg: Service, db: TestDb, prisma: PrismaClient, app: Express;
beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  app = createApp({ version: 't', origins: { storefront: ['http://localhost:3000'], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} }, routes: [storefrontRouter({ prisma, mediaUrl: CDN })] });
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });

describe('product detail sections', () => {
  it('details, care, how to use, specifications (label/value, empty ones dropped), active techniques, video, SEO, stock summary', async () => {
    const p = await liveProduct(prisma, { name: 'Ultra Clear Epoxy', variants: [{ price: 49_900, onHand: 0 }, { price: 99_900, onHand: 4 }] });
    const t1 = await prisma.technique.create({ data: { name: 'Coasters', slug: `coasters-${p.productId}`, sortOrder: 2 } });
    const t2 = await prisma.technique.create({ data: { name: 'Deep Pour', slug: `deep-${p.productId}`, sortOrder: 1 } });
    const off = await prisma.technique.create({ data: { name: 'Retired', slug: `off-${p.productId}`, isActive: false } });
    await prisma.productTechnique.createMany({ data: [t1, t2, off].map((t) => ({ productId: p.productId, techniqueId: t.id })) });
    await prisma.product.update({ where: { id: p.productId }, data: {
      productDetails: ['2:1 mixing ratio', 'Crystal clear'], specificationsCare: ['Store below 30 °C'], howToUse: 'Mix for 3 minutes.',
      specifications: { 'Mix ratio': '2:1', 'Cure time': '24 h', Empty: '  ' }, metaTitle: 'Epoxy | ArtQ', metaDescription: 'Clear resin.', videoMediaId: await readyVideo(prisma),
    } });
    const res = await request(app).get(`/v1/products/${p.slug}`);
    expect(res.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
    expect(res.body).toMatchObject({
      productDetails: ['2:1 mixing ratio', 'Crystal clear'], specificationsCare: ['Store below 30 °C'], howToUse: 'Mix for 3 minutes.',
      specifications: [{ label: 'Cure time', value: '24 h' }, { label: 'Mix ratio', value: '2:1' }],   // alphabetical (jsonb keeps no order)
      techniques: [{ slug: t2.slug, name: 'Deep Pour' }, { slug: t1.slug, name: 'Coasters' }],
      video: { mime: 'video/mp4' }, metaTitle: 'Epoxy | ArtQ', metaDescription: 'Clear resin.', inStock: true,
    });
    await prisma.$executeRawUnsafe(`UPDATE product_variants SET on_hand = 0 WHERE product_id = $1`, p.productId);
    await prisma.$executeRawUnsafe(`SELECT aq_refresh_products(ARRAY[$1]::int[])`, p.productId);
    expect((await request(app).get(`/v1/products/${p.slug}`)).body.inStock).toBe(false);
  });
});

describe('related products', () => {
  let main: LiveProduct, sameCategory: LiveProduct, sameType: LiveProduct, boughtWith: LiveProduct;
  beforeAll(async () => {
    main = await liveProduct(prisma, { name: 'Main Resin' });
    sameCategory = await liveProduct(prisma, { typeId: main.typeId, categoryId: main.categoryId, name: 'Same Category' });
    const otherCat = await val<number>(prisma, `INSERT INTO categories (type_id, name, slug, updated_at) VALUES ($1,'Other Cat','other-cat-rel',now()) RETURNING id`, main.typeId);
    sameType = await liveProduct(prisma, { typeId: main.typeId, categoryId: otherCat, name: 'Same Type' });
    boughtWith = await liveProduct(prisma, { name: 'Bought With' });   // another type entirely
    await liveProduct(prisma, { typeId: main.typeId, categoryId: main.categoryId, name: 'Draft Sibling', status: 'DRAFT' });
    const paid = await order(prisma, { lines: [{ variantId: main.variantIds[0]!, qty: 1 }, { variantId: boughtWith.variantIds[0]!, qty: 1 }], reserve: false });
    await prisma.$executeRawUnsafe(`UPDATE orders SET payment_status = 'PAID' WHERE id = $1`, paid.orderId);
    await order(prisma, { lines: [{ variantId: main.variantIds[0]!, qty: 1 }, { variantId: sameType.variantIds[0]!, qty: 1 }], reserve: false });   // unpaid: not counted
  });

  it('bought together = in the same PAID orders; similar = same category first, then same type; never itself or drafts; cacheable', async () => {
    const res = await request(app).get(`/v1/products/${main.slug}/related`);
    expect(res.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
    expect(res.body.frequentlyBoughtTogether.map((c: { name: string }) => c.name)).toEqual(['Bought With']);
    expect(res.body.similar.map((c: { name: string }) => c.name)).toEqual(['Same Category', 'Same Type']);
    expect(sameCategory.productId).toBeGreaterThan(0);
  });

  it('a draft or unknown product → 404', async () => {
    const draft = await liveProduct(prisma, { status: 'DRAFT' });
    expect((await request(app).get(`/v1/products/${draft.slug}/related`)).status).toBe(404);
  });
});

describe('cards by id (recently viewed)', () => {
  it('in the order asked, duplicates once, only live products; cacheable', async () => {
    const a = await liveProduct(prisma, { name: 'Viewed A' });
    const b = await liveProduct(prisma, { name: 'Viewed B' });
    const draft = await liveProduct(prisma, { name: 'Viewed Draft', status: 'DRAFT' });
    const res = await request(app).get(`/v1/products/by-ids?ids=${b.productId},${draft.productId},${a.productId},${b.productId},999999`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
    expect(res.body.data.map((c: { name: string }) => c.name)).toEqual(['Viewed B', 'Viewed A']);
  });

  it('bad id lists → 400: empty, words, more than 24, missing', async () => {
    for (const qs of ['ids=', 'ids=a,b', `ids=${Array.from({ length: 25 }, (_, i) => i + 1).join(',')}`, '', 'ids=1,,2']) {
      const res = await request(app).get(`/v1/products/by-ids?${qs}`);
      expect(res.status, qs).toBe(400);
    }
    expect((await request(app).get(`/v1/products/by-ids?ids=${Array.from({ length: 24 }, (_, i) => i + 1).join(',')}`)).status).toBe(200);   // exactly 24 is fine
  });
});

describe('pincode check', () => {
  beforeAll(async () => {
    const india = await prisma.country.upsert({ where: { iso2: 'IN' }, update: {}, create: { iso2: 'IN', name: 'India', phoneCode: '+91' } });
    const kerala = await prisma.state.create({ data: { countryId: india.id, name: 'Kerala', code: 'KL', gstCode: '32' } });
    await prisma.postalCode.createMany({ data: [
      { pincode: '682011', officeName: 'ERNAKULAM H.O', district: 'ERNAKULAM', stateId: kerala.id },
      { pincode: '682020', officeName: 'KADAVANTHRA S.O', district: 'ERNAKULAM', stateId: kerala.id },
      { pincode: '695001', officeName: 'THIRUVANANTHAPURAM G.P.O', district: 'THIRUVANANTHAPURAM', stateId: kerala.id },
    ] });
    await prisma.setting.upsert({ where: { key: 'SHIPPING' }, update: { value: DEFAULT_SETTINGS.SHIPPING, isPublic: true }, create: { key: 'SHIPPING', value: DEFAULT_SETTINGS.SHIPPING, isPublic: true } });
  });
  const check = (pin: string) => request(app).get(`/v1/pincodes/${pin}/serviceability`);

  it('a known pincode without its own rule → the default policy (deliverable, COD, 4–7 days); never cached', async () => {
    const res = await check('682011');
    expect(res.headers['cache-control']).toBe(NO_STORE);
    expect(res.body).toEqual({ pincode: '682011', place: { district: 'ERNAKULAM', state: 'Kerala' }, serviceable: true, codAvailable: true, surfaceOnly: false, surfaceAvailable: true, estimatedDays: { min: 4, max: 7 }, reason: null });
  });

  it('an explicit rule wins: blocked → NOT_SERVICEABLE; COD off, surface only and its own delivery days', async () => {
    await prisma.pincodeServiceability.create({ data: { pincode: '682020', isServiceable: false, codAvailable: false } });
    await prisma.pincodeServiceability.create({ data: { pincode: '695001', isServiceable: true, codAvailable: false, surfaceOnly: true, eddMinDays: 2, eddMaxDays: 3 } });
    expect((await check('682020')).body).toMatchObject({ serviceable: false, reason: 'NOT_SERVICEABLE', estimatedDays: null, place: { district: 'ERNAKULAM' } });
    expect((await check('695001')).body).toMatchObject({ serviceable: true, codAvailable: false, surfaceOnly: true, estimatedDays: { min: 2, max: 3 } });
  });

  it('a pincode not in the postal directory is reported as unknown (probably mistyped), not as deliverable', async () => {
    const an = await prisma.state.create({ data: { countryId: (await prisma.country.findUniqueOrThrow({ where: { iso2: 'IN' } })).id, name: 'Andaman and Nicobar Islands', code: 'AN', gstCode: '35' } });
    await prisma.postalCode.create({ data: { pincode: '744101', officeName: 'PORT BLAIR H.O', district: 'SOUTH ANDAMAN', stateId: an.id } });
    await prisma.pincodeServiceability.create({ data: { pincode: '744101', isServiceable: true, codAvailable: false } });   // Port Blair: air-only area (D-7)
    expect((await check('744101')).body).toMatchObject({ serviceable: true, surfaceAvailable: false });
    // A rule cannot stand in for the directory: without a state there is no zone or rate, so checkout could not charge it.
    await prisma.pincodeServiceability.create({ data: { pincode: '999998', isServiceable: true, codAvailable: true } });
    expect((await check('999998')).body).toMatchObject({ place: null, serviceable: false, reason: 'UNKNOWN_PINCODE' });
    await prisma.pincodeServiceability.create({ data: { pincode: '999997', isServiceable: false, codAvailable: false } });
    expect((await check('999997')).body).toMatchObject({ serviceable: false, reason: 'NOT_SERVICEABLE' });
    expect((await check('999999')).body).toEqual({ pincode: '999999', place: null, serviceable: false, codAvailable: false, surfaceOnly: false, surfaceAvailable: false, estimatedDays: null, reason: 'UNKNOWN_PINCODE' });
  });

  it('a default policy of "listed pincodes only" (D-6) makes unlisted known pincodes undeliverable', async () => {
    await prisma.setting.update({ where: { key: 'SHIPPING' }, data: { value: { ...DEFAULT_SETTINGS.SHIPPING, defaultServiceable: false, defaultCod: false } } });
    expect((await check('682011')).body).toMatchObject({ serviceable: false, reason: 'NOT_SERVICEABLE' });
    expect((await check('695001')).body.serviceable).toBe(true);   // its own rule still says yes
    await prisma.setting.update({ where: { key: 'SHIPPING' }, data: { value: DEFAULT_SETTINGS.SHIPPING } });
  });

  it('malformed pincodes → 400 "Enter a 6-digit pincode"', async () => {
    for (const pin of ['68201', '6820111', '082011', 'abcdef']) {
      const res = await check(pin);
      expect(res.status, pin).toBe(400);
      expect(res.body.error.details[0].message).toBe('Enter a 6-digit pincode');
    }
  });
});
