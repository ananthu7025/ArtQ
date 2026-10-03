// Tasks 3.4 / 4.1 (core): the cart (api.md §3.7), product detail + live availability and "Notify me" (api.md §3.3).
// Real PostgreSQL; products pass the real publication gate; stock changes go through aq_adjust_on_hand.
import { NO_STORE, PUBLIC_CACHE_CONTROL } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { cookieSpec } from '../../src/auth/cookies.js';
import { hashToken } from '../../src/cart/service.js';
import { cartRouter } from '../../src/cart/routes.js';
import * as fn from '../../src/db/functions.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { storefrontRouter } from '../../src/storefront/routes.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq, val } from '../helpers/fixtures.js';
import { startPostgres, type Service } from '../helpers/services.js';
import { liveProduct, type LiveProduct } from '../helpers/storefront-fixtures.js';

const WEB = 'http://localhost:3000';
const CDN = (key: string) => `https://cdn.test/${key}`;
const COOKIE = cookieSpec('cart', 'test').name;
let pg: Service, db: TestDb, prisma: PrismaClient, app: Express;
// The 5/min form limit itself is tested with Redis in storefront.test.ts; here it never interferes.
const limiter: RateLimiter = { hit: async () => ({ count: 1, resetMs: 60_000 }) };

beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [cartRouter({ prisma, env: 'test', mediaUrl: CDN }), storefrontRouter({ prisma, mediaUrl: CDN, limiter })] });
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });

/** A browser session: keeps the cart cookie between requests, sends our Origin on writes. */
function shopper() {
  let cookie: string | null = null;
  const keep = (res: request.Response) => {
    const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${COOKIE}=`));
    if (set) cookie = set.split(';')[0]!;
    return res;
  };
  const send = (r: request.Test) => (cookie ? r.set('Cookie', cookie) : r);
  return {
    get cookie() { return cookie; }, set cookie(c: string | null) { cookie = c; },
    get: async (path = '/v1/cart') => keep(await send(request(app).get(path))),
    add: async (variantId: number, quantity?: number) => keep(await send(request(app).post('/v1/cart/items').set('Origin', WEB)).send(quantity === undefined ? { variantId } : { variantId, quantity })),
    patch: async (itemId: number, quantity: number) => keep(await send(request(app).patch(`/v1/cart/items/${itemId}`).set('Origin', WEB)).send({ quantity })),
    remove: async (itemId: number) => keep(await send(request(app).delete(`/v1/cart/items/${itemId}`).set('Origin', WEB))),
    clear: async () => keep(await send(request(app).delete('/v1/cart').set('Origin', WEB))),
  };
}
const recount = (variantId: number, quantity: number) => prisma.$transaction((tx) => fn.adjustOnHand(tx, { actorId: null, rows: [{ variantId, kind: 'RECOUNT', quantity, note: 'test' }] }));

describe('cart: cookie and basics', () => {
  it('no cart yet: an empty cart, no cookie set, never cached', async () => {
    const res = await request(app).get('/v1/cart');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.totals).toMatchObject({ itemCount: 0, subtotal: 0, total: 0, freeShippingThreshold: 100_000, freeShippingRemaining: 100_000 });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['cache-control']).toBe(NO_STORE);
  });

  it('first add creates the cart: HttpOnly, Secure, SameSite=Strict, Path=/v1, 30 days; only the token hash is stored', async () => {
    const p = await liveProduct(prisma, { name: 'Epoxy', variants: [{ price: 49_900, mrp: 59_900, onHand: 10 }] });
    const s = shopper();
    const res = await s.add(p.variantIds[0]!, 2);
    expect(res.status).toBe(201);
    const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${COOKIE}=`))!;
    expect(set).toMatch(/; Path=\/v1; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/);
    const token = s.cookie!.split('=')[1]!;
    expect(await prisma.cart.count({ where: { tokenHash: hashToken(token) } })).toBe(1);
    expect(await prisma.cart.count({ where: { tokenHash: token } })).toBe(0);
    expect(res.body.items).toEqual([expect.objectContaining({ productSlug: p.slug, productName: 'Epoxy', variantLabel: '100 gm', quantity: 2, unitPrice: 49_900, unitMrp: 59_900, lineTotal: 99_800, maxQuantity: 10, available: true, priceChanged: false })]);
    expect(res.body.items[0].image.url).toMatch(/^https:\/\/cdn\.test\//);
    expect(res.body.totals).toMatchObject({ itemCount: 2, subtotal: 99_800, mrpTotal: 1_19_800, mrpDiscount: 20_000, total: 99_800, savings: 20_000, freeShippingRemaining: 200, shipping: { amount: null, estimated: true, freeApplied: false } });
    expect(res.headers['cache-control']).toBe(NO_STORE);
  });

  it('adding the same size again merges; a different size is a new line; reaching ₹1000 qualifies for free shipping', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 30_000, onHand: 10 }, { price: 50_000, onHand: 10 }] });
    const s = shopper();
    await s.add(p.variantIds[0]!);
    const merged = await s.add(p.variantIds[0]!, 2);
    expect(merged.body.items.map((i: { quantity: number }) => i.quantity)).toEqual([3]);
    const two = await s.add(p.variantIds[1]!);
    expect(two.body.items).toHaveLength(2);
    expect(two.body.totals).toMatchObject({ itemCount: 4, subtotal: 1_40_000, freeShippingRemaining: 0, shipping: { freeApplied: true } });
    expect(await prisma.cart.count({ where: { tokenHash: hashToken(s.cookie!.split('=')[1]!) } })).toBe(1);   // still one cart
  });

  it('a forged or unknown cookie is no cart: reading is empty, adding starts a new cart with a new cookie', async () => {
    const p = await liveProduct(prisma);
    const s = shopper();
    s.cookie = `${COOKIE}=not-a-real-token`;
    expect((await s.get()).body.items).toEqual([]);
    const res = await s.add(p.variantIds[0]!);
    expect(res.status).toBe(201);
    expect(s.cookie).not.toBe(`${COOKIE}=not-a-real-token`);
  });

  it('writes need our Origin (cookie routes are CSRF-protected)', async () => {
    const p = await liveProduct(prisma);
    const res = await request(app).post('/v1/cart/items').send({ variantId: p.variantIds[0] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_REJECTED');
  });
});

describe('cart: what can be added', () => {
  let p: LiveProduct;
  beforeAll(async () => { p = await liveProduct(prisma, { variants: [{ price: 10_000, onHand: 60 }, { price: 20_000, onHand: 3 }, { price: 30_000, onHand: 0 }] }); });

  it('validation (shared rule): missing option, 0, 51, fractions, extra keys → 400 with messages; nothing stored', async () => {
    const s = shopper();
    const cases: [object, string, string][] = [
      [{}, 'variantId', 'Choose an option'], [{ variantId: p.variantIds[0], quantity: 0 }, 'quantity', 'Add at least 1'],
      [{ variantId: p.variantIds[0], quantity: 51 }, 'quantity', 'At most 50 per item'], [{ variantId: p.variantIds[0], quantity: 1.5 }, 'quantity', 'Use a whole number'],
      [{ variantId: p.variantIds[0], price: 1 }, '', ''],
    ];
    for (const [body, path, message] of cases) {
      const res = await request(app).post('/v1/cart/items').set('Origin', WEB).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.details.some((x: { path: string; message: string }) => x.path === path && (!message || x.message === message)), JSON.stringify(res.body.error.details)).toBe(true);
    }
    expect(s.cookie).toBeNull();
  });

  it('exactly 50 of one item is fine; one more → 422 QUANTITY_LIMIT', async () => {
    const s = shopper();
    expect((await s.add(p.variantIds[0]!, 50)).status).toBe(201);
    const over = await s.add(p.variantIds[0]!, 1);
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({ code: 'QUANTITY_LIMIT', details: { max: 50, inCart: 50 } });
  });

  it('more than in stock → 409 OUT_OF_STOCK with what is left (counting what is already in the cart); sold out says so', async () => {
    const s = shopper();
    expect((await s.add(p.variantIds[1]!, 2)).status).toBe(201);
    const more = await s.add(p.variantIds[1]!, 2);
    expect(more.status).toBe(409);
    expect(more.body.error).toMatchObject({ code: 'OUT_OF_STOCK', message: 'Only 3 left (you already have 2 in your cart)', details: { available: 3, inCart: 2 } });
    const sold = await s.add(p.variantIds[2]!);
    expect(sold.body.error).toMatchObject({ code: 'OUT_OF_STOCK', message: 'This option is out of stock', details: { available: 0, inCart: 0 } });
    expect((await s.get()).body.items.map((i: { quantity: number }) => i.quantity)).toEqual([2]);
  });

  it('reserved units count as gone (available = on hand − reserved)', async () => {
    const q = await liveProduct(prisma, { variants: [{ price: 10_000, onHand: 5 }] });
    await prisma.$executeRawUnsafe(`UPDATE product_variants SET reserved = 4 WHERE id = $1`, q.variantIds[0]);
    const res = await shopper().add(q.variantIds[0]!, 2);
    expect(res.body.error).toMatchObject({ code: 'OUT_OF_STOCK', details: { available: 1 } });
  });

  it('a draft product, an inactive size or an unknown id → 404 "no longer available"', async () => {
    const draft = await liveProduct(prisma, { status: 'DRAFT' });
    const inactive = await liveProduct(prisma, { variants: [{ price: 10_000 }, { price: 20_000, active: false }] });
    for (const id of [draft.variantIds[0]!, inactive.variantIds[1]!, 999_999]) {
      const res = await shopper().add(id);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('This option is no longer available');
    }
  });

  it('five adds at once from one cart never exceed stock (3 left → three succeed, two refused)', async () => {
    const q = await liveProduct(prisma, { variants: [{ price: 10_000, onHand: 3 }] });
    const s = shopper();
    await s.add(q.variantIds[0]!, 1);
    await s.remove((await s.get()).body.items[0].id);
    const results = await Promise.all(Array.from({ length: 5 }, () => s.add(q.variantIds[0]!, 1)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 409, 409]);
    expect((await s.get()).body.items[0].quantity).toBe(3);
  });
});

describe('cart: change, remove, clear', () => {
  it('PATCH sets a quantity (raising is checked against stock); 0 removes; DELETE removes; DELETE /cart empties', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 10_000, onHand: 4 }, { price: 20_000, onHand: 9 }] });
    const s = shopper();
    await s.add(p.variantIds[0]!, 1);
    const view = await s.add(p.variantIds[1]!, 1);
    const [a, b] = view.body.items as { id: number }[];
    expect((await s.patch(a!.id, 4)).body.items[0].quantity).toBe(4);
    expect((await s.patch(a!.id, 5)).body.error).toMatchObject({ code: 'OUT_OF_STOCK', details: { available: 4, inCart: 4 } });
    expect((await s.patch(a!.id, 2)).body.items[0].quantity).toBe(2);
    expect((await s.patch(a!.id, 0)).body.items.map((i: { id: number }) => i.id)).toEqual([b!.id]);
    expect((await s.remove(b!.id)).body.items).toEqual([]);
    await s.add(p.variantIds[0]!, 1);
    expect((await s.clear()).body.items).toEqual([]);
  });

  it('someone else\'s item, an unknown item, or no cart at all → 404; bad quantities → 400', async () => {
    const p = await liveProduct(prisma);
    const mine = shopper(); const theirs = shopper();
    const item = (await theirs.add(p.variantIds[0]!)).body.items[0].id as number;
    await mine.add(p.variantIds[0]!);
    expect((await mine.patch(item, 2)).status).toBe(404);
    expect((await mine.remove(item)).status).toBe(404);
    expect((await mine.patch(999_999, 1)).status).toBe(404);
    expect((await shopper().remove(item)).status).toBe(404);
    expect((await shopper().patch(item, 1)).status).toBe(404);
    expect((await theirs.patch(item, -1)).body.error.details[0].message).toBe('Use 0 to remove');
    expect((await theirs.patch(item, 51)).status).toBe(400);
    expect((await theirs.get()).body.items[0].quantity).toBe(1);   // untouched
  });
});

describe('cart: re-priced on every read', () => {
  it('stock fell below the quantity → lowered to what is left, explained, saved; sold out → kept but not counted', async () => {
    const p = await liveProduct(prisma, { name: 'Mica Gold', variants: [{ price: 10_000, onHand: 10 }, { price: 20_000, onHand: 10 }] });
    const s = shopper();
    await s.add(p.variantIds[0]!, 6);
    await s.add(p.variantIds[1]!, 2);
    await recount(p.variantIds[0]!, 4);
    await recount(p.variantIds[1]!, 0);
    const view = (await s.get()).body;
    expect(view.items[0]).toMatchObject({ quantity: 4, available: true, warning: 'Only 4 left, so we changed the quantity to 4' });
    expect(view.items[1]).toMatchObject({ quantity: 2, available: false, lineTotal: 0, maxQuantity: 0, warning: 'Out of stock' });
    expect(view.totals).toMatchObject({ itemCount: 4, subtotal: 40_000 });
    expect(view.warnings).toEqual(['Mica Gold (100 gm): Only 4 left, so we changed the quantity to 4', 'Mica Gold (200 gm): Out of stock']);
    expect((await s.get()).body.items[0].warning).toBeUndefined();     // saved: no longer above stock
  });

  it('a price change is flagged once with old → new; an unpublished product is "No longer available"', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 10_000, onHand: 10 }] });
    const gone = await liveProduct(prisma, { variants: [{ price: 5_000, onHand: 10 }] });
    const s = shopper();
    await s.add(p.variantIds[0]!);
    await s.add(gone.variantIds[0]!);
    await prisma.$executeRawUnsafe(`UPDATE product_variants SET price = 12_000 WHERE id = $1`, p.variantIds[0]);
    await fn.refreshProducts(prisma, [p.productId]);
    await prisma.$executeRawUnsafe(`UPDATE products SET status = 'DRAFT' WHERE id = $1`, gone.productId);
    const view = (await s.get()).body;
    expect(view.items[0]).toMatchObject({ unitPrice: 12_000, priceChanged: true, warning: 'Price changed from ₹100 to ₹120', lineTotal: 12_000 });
    expect(view.items[1]).toMatchObject({ available: false, warning: 'No longer available' });
    expect(view.totals.subtotal).toBe(12_000);
    expect((await s.get()).body.items[0]).toMatchObject({ priceChanged: false });
  });
});

describe('product detail and live availability', () => {
  it('detail: variants cheapest first; options only where there is a choice; publicly cacheable; no stock in it', async () => {
    const p = await liveProduct(prisma, { name: 'Mica Pigment', images: 2, variants: [
      { price: 19_000, size: '10 gm', color: 'Gold', colorHex: '#D4AF37' }, { price: 19_000, size: '10 gm', color: 'Silver', colorHex: '#C0C0C0' },
      { price: 49_000, mrp: 59_000, size: '50 gm', color: 'Gold', colorHex: '#D4AF37' }, { price: 9_000, size: '50 gm', color: 'Retired', active: false },
    ] });
    const res = await request(app).get(`/v1/products/${p.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
    expect(res.body).toMatchObject({ id: p.productId, name: 'Mica Pigment', fromPrice: 19_000, maxPrice: 49_000, options: { size: ['10 gm', '50 gm'], color: [{ name: 'Gold', hex: '#D4AF37' }, { name: 'Silver', hex: '#C0C0C0' }], thickness: [] } });
    expect(res.body.variants.map((v: { label: string }) => v.label)).toEqual(['10 gm / Gold', '10 gm / Silver', '50 gm / Gold']);
    expect(res.body.variants[2]).toMatchObject({ mrp: 59_000, discountPercent: 17 });
    expect(res.body.images).toHaveLength(2);
    // No counts or live stock in the cached detail (only the yes/no summary cards also show): those come from /availability.
    expect(JSON.stringify(res.body)).not.toMatch(/onHand|reserved|available|stockStatus|maxQuantity|lowStock/i);
    expect(typeof res.body.inStock).toBe('boolean');
  });

  it('availability: IN/LOW/OUT per variant (low = at or below its threshold), max quantity capped at 50; never cached', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 10_000, onHand: 80 }, { price: 20_000, onHand: 5, lowStock: 5 }, { price: 30_000, onHand: 6, lowStock: 5 }, { price: 40_000, onHand: 0 }] });
    const res = await request(app).get(`/v1/products/${p.slug}/availability`);
    expect(res.headers['cache-control']).toBe(NO_STORE);
    expect(res.body.variants.map((v: { stockStatus: string; maxQuantity: number }) => [v.stockStatus, v.maxQuantity])).toEqual([['IN_STOCK', 50], ['LOW_STOCK', 5], ['IN_STOCK', 6], ['OUT_OF_STOCK', 0]]);
  });

  it('drafts and unknown slugs → 404; an old slug → {redirectTo} the new one', async () => {
    const draft = await liveProduct(prisma, { status: 'DRAFT' });
    expect((await request(app).get(`/v1/products/${draft.slug}`)).status).toBe(404);
    expect((await request(app).get(`/v1/products/${draft.slug}/availability`)).status).toBe(404);
    expect((await request(app).get('/v1/products/no-such-thing')).status).toBe(404);
    const p = await liveProduct(prisma);
    await prisma.slugRedirect.create({ data: { entity: 'product', oldSlug: `old-${p.slug}`, newSlug: p.slug } });
    expect((await request(app).get(`/v1/products/old-${p.slug}`)).body).toEqual({ redirectTo: p.slug });
  });
});

describe('Notify me', () => {
  const notify = (slug: string, body: object) => request(app).post(`/v1/products/${slug}/notify`).set('Origin', WEB).send(body);

  it('sold-out size → 201 SUBSCRIBED; the same email again (any case) → 200 ALREADY_SUBSCRIBED; one request stored', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 10_000, onHand: 5 }, { price: 20_000, onHand: 0 }] });
    const email = `maker-${uniq()}@example.com`;
    const first = await notify(p.slug, { variantId: p.variantIds[1], email });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ status: 'SUBSCRIBED' });
    expect((await notify(p.slug, { variantId: p.variantIds[1], email: email.toUpperCase() })).body).toEqual({ status: 'ALREADY_SUBSCRIBED' });
    expect(await val<number>(prisma, `SELECT count(*)::int FROM stock_notifications WHERE variant_id = $1`, p.variantIds[1])).toBe(1);
    const row = await prisma.stockNotification.findFirstOrThrow({ where: { variantId: p.variantIds[1] } });
    expect(row).toMatchObject({ productId: p.productId, status: 'PENDING', userId: null });
  });

  it('an in-stock size → 409 IN_STOCK; a size of another product → 404; bad email → 400 with the shared message', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 10_000, onHand: 5 }] });
    const other = await liveProduct(prisma, { variants: [{ price: 10_000, onHand: 0 }] });
    expect((await notify(p.slug, { variantId: p.variantIds[0], email: 'a@example.com' })).body.error).toMatchObject({ code: 'IN_STOCK', details: { available: 5 } });
    expect((await notify(p.slug, { variantId: other.variantIds[0], email: 'a@example.com' })).status).toBe(404);
    const bad = await notify(other.slug, { variantId: other.variantIds[0], email: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([{ location: 'body', path: 'email', message: 'Enter a valid email address' }]);
    expect((await notify(other.slug, { email: 'a@example.com' })).body.error.details[0]).toMatchObject({ path: 'variantId', message: 'Choose an option' });
  });

  it('the same request sent 4 times at once → one stored', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 10_000, onHand: 0 }] });
    const email = `race-${uniq()}@example.com`;
    const res = await Promise.all(Array.from({ length: 4 }, () => notify(p.slug, { variantId: p.variantIds[0], email })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(await prisma.stockNotification.count({ where: { email } })).toBe(1);
  });
});

describe('cart: shipping estimate for a pincode (task 4.5, ?pincode= on every cart call)', () => {
  beforeAll(async () => {
    await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
    const state = (name: string) => prisma.state.findFirstOrThrow({ where: { name } });
    await prisma.postalCode.createMany({ data: [
      { pincode: '682011', officeName: 'ERNAKULAM H.O', district: 'ERNAKULAM', stateId: (await state('Kerala')).id },
      { pincode: '744101', officeName: 'PORT BLAIR H.O', district: 'SOUTH ANDAMAN', stateId: (await state('Andaman and Nicobar Islands')).id },
    ], skipDuplicates: true });
  });

  it('a quote for the pincode is added to the total (300 g + 150 g packaging → Kerala ₹50); free from ₹1,000; lines carry their product id', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 49_900, onHand: 10 }] });
    const s = shopper();
    await s.add(p.variantIds[0]!);
    const res = await s.get('/v1/cart?pincode=682011');
    expect(res.body.items[0].productId).toBe(p.productId);
    expect(res.body.totals.shipping).toEqual({ amount: 5000, estimated: false, freeApplied: false, heavySurcharge: 0, pincode: '682011', problem: null });
    expect(res.body.totals.total).toBe(49_900 + 5000);
    const two = await s.patch(res.body.items[0].id, 3);   // patch without the pincode: estimate only
    expect(two.body.totals.shipping).toMatchObject({ amount: null, estimated: true, pincode: null });
    const free = await s.get('/v1/cart?pincode=682011');
    expect(free.body.totals.shipping).toMatchObject({ amount: 0, freeApplied: true });
    expect(free.body.totals.total).toBe(3 * 49_900);
    expect(free.body.totals.savings).toBe(11_000);   // the shipping waived: 1,050 g → Kerala 2 kg slab ₹110
  });

  it('why it cannot ship: unknown pincode, blocked pincode, resin to an air-only area; malformed pincode → 400', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 20_000 }] });
    await prisma.productVariant.update({ where: { id: p.variantIds[0]! }, data: { shippingClass: 'SURFACE_ONLY' } });
    const s = shopper();
    await s.add(p.variantIds[0]!);
    expect((await s.get('/v1/cart?pincode=999999')).body.totals).toMatchObject({ shipping: { amount: null, problem: 'UNKNOWN_PINCODE', pincode: '999999' }, total: 20_000 });
    expect((await s.get('/v1/cart?pincode=744101')).body.totals.shipping).toMatchObject({ amount: null, problem: 'SHIPPING_RESTRICTED' });
    await prisma.pincodeServiceability.create({ data: { pincode: '682011', isServiceable: false, codAvailable: false } });
    expect((await s.get('/v1/cart?pincode=682011')).body.totals.shipping.problem).toBe('PINCODE_NOT_SERVICEABLE');
    await prisma.pincodeServiceability.delete({ where: { pincode: '682011' } });
    expect((await s.get('/v1/cart?pincode=68201')).status).toBe(400);
    expect((await s.get('/v1/cart?zip=682011')).status).toBe(400);
    expect((await shopper().get('/v1/cart?pincode=682011')).body.totals.shipping).toMatchObject({ amount: null, pincode: null });   // empty cart: nothing to ship
  });
});

describe('checkout quote (task 4.6): the cart for a pincode and a payment method', () => {
  const quote = (s: ReturnType<typeof shopper>, body: object) => {
    const r = request(app).post('/v1/checkout/quote').set('Origin', WEB);
    return (s.cookie ? r.set('Cookie', s.cookie) : r).send(body);
  };
  const setPayment = (o: object) => prisma.setting.update({ where: { key: 'PAYMENT' }, data: { value: { razorpayEnabled: true, codEnabled: true, codFee: 4000, codMin: 20_000, codMax: 500_000, pendingExpiryMinutes: 30, autoRefundExcessCapture: true, ...o } } });
  beforeAll(async () => { await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma); });

  it('online: shipping in the total, COD offered with its fee; COD: the fee is added; nothing blocks', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 49_900 }] });
    const s = shopper();
    await s.add(p.variantIds[0]!);
    const online = await quote(s, { pincode: '682011' });
    expect(online.status).toBe(200);
    expect(online.body).toMatchObject({ onlineEnabled: true, cod: { available: true, reason: null, fee: 4000, min: 20_000, max: 500_000 }, blocking: [] });
    expect(online.body.cart.totals).toMatchObject({ codFee: 0, total: 49_900 + 5000, shipping: { amount: 5000, pincode: '682011' } });
    const cod = await quote(s, { pincode: '682011', paymentMethod: 'COD' });
    expect(cod.body.cart.totals).toMatchObject({ codFee: 4000, total: 49_900 + 5000 + 4000 });
    expect(cod.body.blocking).toEqual([]);
  });

  it('COD refused with the reason: pincode without COD, below the minimum, above the maximum, switched off', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 15_000 }] });
    const s = shopper();
    await s.add(p.variantIds[0]!);
    expect((await quote(s, { pincode: '682011', paymentMethod: 'COD' })).body).toMatchObject({ cod: { available: true }, blocking: [] });   // ₹150 + ₹50 + ₹40 = ₹240 ≥ ₹200
    await setPayment({ codMin: 25_000 });
    expect((await quote(s, { pincode: '682011', paymentMethod: 'COD' })).body).toMatchObject({ cod: { available: false, reason: 'BELOW_MIN' }, blocking: ['COD_NOT_AVAILABLE'] });
    expect((await quote(s, { pincode: '682011' })).body.blocking).toEqual([]);                     // paying online is fine
    await setPayment({ codMax: 20_000 });
    expect((await quote(s, { pincode: '682011', paymentMethod: 'COD' })).body.cod.reason).toBe('ABOVE_MAX');
    await setPayment({ codEnabled: false });
    expect((await quote(s, { pincode: '682011', paymentMethod: 'COD' })).body.cod.reason).toBe('COD_DISABLED');
    await setPayment({});
    await prisma.pincodeServiceability.create({ data: { pincode: '682011', isServiceable: true, codAvailable: false } });
    expect((await quote(s, { pincode: '682011', paymentMethod: 'COD' })).body.cod.reason).toBe('PINCODE_NO_COD');
    await prisma.pincodeServiceability.delete({ where: { pincode: '682011' } });
  });

  it('blocking reasons: unknown pincode, online payments off, empty cart; malformed body 400; a saved address needs an account (404)', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 30_000 }] });
    const s = shopper();
    await s.add(p.variantIds[0]!);
    expect((await quote(s, { pincode: '999999' })).body.blocking).toEqual(['UNKNOWN_PINCODE']);
    await setPayment({ razorpayEnabled: false });
    expect((await quote(s, { pincode: '682011' })).body).toMatchObject({ onlineEnabled: false, blocking: ['ONLINE_DISABLED'] });
    await setPayment({});
    expect((await quote(shopper(), { pincode: '682011' })).body.blocking).toContain('CART_EMPTY');
    expect((await quote(s, {})).status).toBe(400);
    expect((await quote(s, { pincode: '682011', shippingAddressId: 1 })).status).toBe(400);
    expect((await quote(s, { shippingAddressId: 1 })).status).toBe(404);
    expect((await request(app).post('/v1/checkout/quote').send({ pincode: '682011' })).status).toBe(403);   // Origin guard
  });
});
