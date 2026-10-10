// Task 4.7: POST /checkout/initiate on real PostgreSQL with a stub Razorpay (FakeRazorpay). COD and online happy paths,
// every refusal, the failure matrix rows 1–6 (architecture.md §7.3), one pending order per cart, and AT-01 (20 carts,
// last 5 units), AT-02 (10 parallel same key + a different body), AT-03 (provider created the order, the process died
// before TX2: the retry adopts it by receipt; without a retry the reconciler does).
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { cookieSpec } from '../../src/auth/cookies.js';
import { cartRouter } from '../../src/cart/routes.js';
import { CartService } from '../../src/cart/service.js';
import { CheckoutService } from '../../src/checkout/initiate.js';
import { FakeRazorpay, type PaymentProvider } from '../../src/payments/razorpay.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { one, uniq } from '../helpers/fixtures.js';
import { startPostgres, type Service } from '../helpers/services.js';
import { liveProduct, type LiveProduct } from '../helpers/storefront-fixtures.js';

const WEB = 'http://localhost:3000';
const CART = cookieSpec('cart', 'test').name;
const mediaUrl = (k: string) => `https://cdn.test/${k}`;
let pg: Service, db: TestDb, prisma: PrismaClient, kerala: number, karnataka: number;
let fake: FakeRazorpay;
let grace = 120_000;
const apps = new Map<string, Express>();
/** An app whose provider is the shared fake (or none), with a short idempotency lock so takeovers happen in a test. */
function app(provider: 'fake' | 'none' = 'fake'): Express {
  const key = `${provider}-${grace}`;
  if (!apps.has(key)) {
    const p: PaymentProvider | null = provider === 'fake' ? { keyId: 'rzp_test_fake', createOrder: (o) => fake.createOrder(o), findOrdersByReceipt: (r) => fake.findOrdersByReceipt(r), fetchPayment: (id) => fake.fetchPayment(id), orderPayments: (id) => fake.orderPayments(id), verifySignature: (o, pid, sig) => fake.verifySignature(o, pid, sig) } : null;
    apps.set(key, createApp({ version: 't', origins: { storefront: [WEB], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} },
      routes: [cartRouter({ prisma, env: 'test', mediaUrl, checkout: { provider: p, storeName: 'ArtQ', log: pino({ level: 'silent' }), lockSeconds: 1, lookupGraceMs: grace } })] } as Parameters<typeof createApp>[0]));
  }
  return apps.get(key)!;
}

beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  kerala = (await prisma.state.findFirstOrThrow({ where: { name: 'Kerala' } })).id;
  karnataka = (await prisma.state.findFirstOrThrow({ where: { name: 'Karnataka' } })).id;
  await prisma.postalCode.create({ data: { pincode: '682011', officeName: 'ERNAKULAM H.O', district: 'ERNAKULAM', stateId: kerala } });
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });
beforeEach(() => { fake = new FakeRazorpay(); grace = 120_000; });

/** A guest with a cart holding `qty` of the product's first variant. */
async function guest(p: LiveProduct, qty = 1, a = app()) {
  const res = await request(a).post('/v1/cart/items').set('Origin', WEB).send({ variantId: p.variantIds[0], quantity: qty });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const cookie = `${CART}=${String(([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${CART}=`))).slice(CART.length + 1).split(';')[0]}`;
  const quote = async (method: 'RAZORPAY' | 'COD') => (await request(a).post('/v1/checkout/quote').set('Origin', WEB).set('Cookie', cookie).send({ pincode: '682011', paymentMethod: method })).body.cart.totals.total as number;
  const body = async (o: object = {}, method: 'RAZORPAY' | 'COD' = 'RAZORPAY') => ({
    contact: { email: `g${uniq()}@example.com`, phone: '98470 12345' },
    shippingAddress: { fullName: 'Hema R', phone: '9847012345', line1: '12 Rose Villa', city: 'Kochi', stateId: kerala, pincode: '682011' },
    paymentMethod: method, expectedTotal: await quote(method), acceptTerms: true, ...o,
  });
  const initiate = (b: object, key: string = randomUUID(), with_ = a) => request(with_).post('/v1/checkout/initiate').set('Origin', WEB).set('Cookie', cookie).set('Idempotency-Key', key).send(b);
  return { cookie, body, initiate, quote };
}
const orderOf = (orderNumber: string) => prisma.order.findUniqueOrThrow({ where: { orderNumber }, include: { items: true, paymentAttempts: true, reservations: true, history: true, redemption: true } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const anyFakeOrderId = expect.stringMatching(/^order_fake\d+$/) as unknown as string;

describe('cash on delivery', () => {
  it('placed at once: PLACED + COD_PENDING, items snapshotted, stock held, cart converted, history, order.placed; the same key replays', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 49_900, onHand: 10 }] });
    const g = await guest(p, 2);
    const b = await g.body({}, 'COD');
    const key = randomUUID();
    const res = await g.initiate(b, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ orderNumber: expect.stringMatching(/^AQ\d+$/), status: 'PLACED', total: 2 * 49_900 + 7000 + 4000 });   // 750 g → Kerala 1 kg ₹70, COD ₹40
    const o = await orderOf(res.body.orderNumber);
    expect(o).toMatchObject({ status: 'PLACED', paymentStatus: 'COD_PENDING', paymentMethod: 'COD', codFee: 4000, total: b.expectedTotal, shipPincode: '682011', shipState: 'Kerala', shipStateCode: '32', contactPhone: '+919847012345', expiresAt: null });
    expect(o.items).toEqual([expect.objectContaining({ variantId: p.variantIds[0], quantity: 2, unitPrice: 49_900, lineTotal: 99_800, sku: expect.any(String), hsnCode: '3907', weightG: 300 })]);
    expect(o.reservations.map((r) => [r.quantity, r.status])).toEqual([[2, 'ACTIVE']]);
    expect(o.history.map((h) => `${h.dimension}:${h.fromValue ?? ''}→${h.toValue}`).sort()).toEqual(['ORDER:PENDING_PAYMENT→PLACED', 'ORDER:→PENDING_PAYMENT', 'PAYMENT:UNPAID→COD_PENDING']);
    expect(await prisma.cart.findFirst({ where: { id: o.cartId! } })).toMatchObject({ status: 'CONVERTED' });
    expect(await one(prisma, `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'order.placed' AND aggregate_id = $1`, o.orderNumber)).toEqual({ n: 1 });
    expect(await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variantIds[0]! } })).toMatchObject({ reserved: 2 });
    const again = await g.initiate(b, key);
    expect([again.status, again.headers['idempotent-replayed'], again.body]).toEqual([201, 'true', res.body]);
    expect(await prisma.order.count({ where: { cartId: o.cartId } })).toBe(1);
    expect((await g.initiate(await g.body({}, 'COD').catch(() => b))).body.error.code).toBe('CART_EMPTY');   // the cart was converted
  });

  it('a coupon is redeemed with the order (reserved → redeemed)', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 49_900 }] });
    const c = await prisma.coupon.create({ data: { code: `COD${uniq().toUpperCase()}`, title: 'x', type: 'FLAT', value: 5000 } });
    const g = await guest(p);
    expect((await request(app()).post('/v1/cart/coupon').set('Origin', WEB).set('Cookie', g.cookie).send({ code: c.code })).status).toBe(200);
    const res = await g.initiate(await g.body({}, 'COD'));
    expect(res.status).toBe(201);
    const o = await orderOf(res.body.orderNumber);
    expect(o).toMatchObject({ couponDiscount: 5000, couponCode: c.code });
    expect(o.redemption).toMatchObject({ status: 'REDEEMED', discount: 5000 });
    expect(await prisma.coupon.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ reservedCount: 0, redeemedCount: 1 });
  });
});

describe('online (Razorpay)', () => {
  it('201 with the Razorpay details; attempt CREATED with the provider order; order held for 30 minutes', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 120_000 }] });
    const g = await guest(p);
    const b = await g.body({ contact: { email: 'hema@example.com', phone: '9847012345' } });
    const res = await g.initiate(b);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ orderNumber: expect.any(String), status: 'PENDING_PAYMENT', total: 120_000, expiresAt: expect.any(String),
      razorpay: { keyId: 'rzp_test_fake', orderId: anyFakeOrderId, amount: 120_000, currency: 'INR', name: 'ArtQ', prefill: { name: 'Hema R', email: 'hema@example.com', contact: '+919847012345' } } });
    const o = await orderOf(res.body.orderNumber);
    expect(o).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID', shippingFee: 0, total: 120_000 });   // ≥ ₹1,000: free shipping
    expect(o.paymentAttempts).toEqual([expect.objectContaining({ receipt: `AQA_${o.id}`, providerOrderId: fake.orders[0]!.id, status: 'CREATED', amount: 120_000 })]);
    expect(Math.round((o.expiresAt!.getTime() - Date.now()) / 60_000)).toBe(30);
    expect(fake.orders[0]).toMatchObject({ receipt: `AQA_${o.id}`, amount: 120_000 });
  });

  it('a new key for a cart with a pending order returns that order (200), never a second one', async () => {
    const p = await liveProduct(prisma);
    const g = await guest(p);
    const first = await g.initiate(await g.body());
    const second = await g.initiate(await g.body());
    expect([second.status, second.body.orderNumber, second.body.razorpay.orderId]).toEqual([200, first.body.orderNumber, first.body.razorpay.orderId]);
    expect(fake.createCalls).toBe(1);
  });

  it('provider refuses (4xx) → order kept, attempt CREATION_FAILED, 201 retryPayment', async () => {
    const p = await liveProduct(prisma);
    const g = await guest(p);
    fake.next = ['definitive'];
    const res = await g.initiate(await g.body());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING_PAYMENT', razorpay: null, retryPayment: true });
    expect((await orderOf(res.body.orderNumber)).paymentAttempts[0]).toMatchObject({ status: 'CREATION_FAILED', lastError: expect.stringContaining('400') });
  });

  it('provider timeout → 202 PAYMENT_STARTING (key kept open); a quick retry is IN_PROGRESS; after the wait the retry adopts the order Razorpay did create', async () => {
    const p = await liveProduct(prisma);
    const g = await guest(p);
    fake.next = ['created-then-unknown'];
    const b = await g.body();
    const key = randomUUID();
    const res = await g.initiate(b, key);
    expect([res.status, res.body.status, res.body.retryAfter]).toEqual([202, 'PAYMENT_STARTING', 3]);
    expect((await orderOf(res.body.orderNumber)).paymentAttempts[0]!.status).toBe('PROVIDER_UNKNOWN');
    const quick = await g.initiate(b, key);
    expect([quick.status, quick.body.error.code, quick.headers['retry-after']]).toEqual([409, 'REQUEST_IN_PROGRESS', '2']);
    await sleep(3100);
    const later = await g.initiate(b, key);
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    expect(later.body).toMatchObject({ orderNumber: res.body.orderNumber, razorpay: { orderId: fake.orders[0]!.id } });
    expect(fake.createCalls).toBe(1);
    expect((await orderOf(res.body.orderNumber)).paymentAttempts[0]).toMatchObject({ status: 'CREATED', providerOrderId: fake.orders[0]!.id });
  });

  it('provider timeout and nothing created: within the lookup grace it keeps waiting; after it, the order is created with the same receipt', async () => {
    const p = await liveProduct(prisma);
    const g = await guest(p);
    fake.next = ['unknown'];
    const b = await g.body();
    const key = randomUUID();
    const first = await g.initiate(b, key);
    expect(first.status).toBe(202);
    await sleep(3100);
    const waiting = await g.initiate(b, key);
    expect([waiting.status, waiting.body.retryAfter]).toEqual([202, 5]);
    grace = 0;
    await sleep(5100);
    const created = await g.initiate(b, key, app());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const o = await orderOf(first.body.orderNumber);
    expect(fake.orders.map((x) => x.receipt)).toEqual([`AQA_${o.id}`]);
    expect(o.paymentAttempts[0]).toMatchObject({ status: 'CREATED', providerOrderId: fake.orders[0]!.id });
  }, 20_000);

  it('online payments off (no keys) → 422 PAYMENT_METHOD_UNAVAILABLE; COD still works', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 49_900 }] });
    const g = await guest(p, 1, app('none'));
    expect((await g.initiate(await g.body())).body.error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    expect((await request(app('none')).post('/v1/checkout/quote').set('Origin', WEB).set('Cookie', g.cookie).send({ pincode: '682011' })).body).toMatchObject({ onlineEnabled: false, blocking: ['ONLINE_DISABLED'] });
    expect((await g.initiate(await g.body({}, 'COD'))).status).toBe(201);
  });
});

describe('refusals (nothing is created)', () => {
  it('Idempotency-Key, body rules, the total, the address, delivery, COD limits, an empty cart', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 49_900 }] });
    const g = await guest(p);
    const b = await g.body();
    expect((await request(app()).post('/v1/checkout/initiate').set('Origin', WEB).set('Cookie', g.cookie).send(b)).status).toBe(400);   // no key
    const bad = await g.initiate({ ...b, contact: { email: 'x', phone: '123' }, acceptTerms: false });
    expect(bad.body.error.details.map((x: { path: string }) => x.path).sort()).toEqual(['acceptTerms', 'contact.email', 'contact.phone']);
    const changed = await g.initiate({ ...b, expectedTotal: b.expectedTotal - 1 });
    expect([changed.status, changed.body.error.code, changed.body.error.details.total]).toEqual([409, 'PRICE_CHANGED', b.expectedTotal]);
    const wrongState = await g.initiate({ ...b, shippingAddress: { ...b.shippingAddress, stateId: karnataka } });
    expect(wrongState.body.error.details).toEqual([{ location: 'body', path: 'shippingAddress.pincode', message: 'This pincode is in Kerala' }]);
    await prisma.pincodeServiceability.create({ data: { pincode: '682011', isServiceable: false, codAvailable: false } });
    expect((await g.initiate(b)).body.error.code).toBe('PINCODE_NOT_SERVICEABLE');
    await prisma.pincodeServiceability.delete({ where: { pincode: '682011' } });
    await prisma.setting.update({ where: { key: 'PAYMENT' }, data: { value: { razorpayEnabled: true, codEnabled: true, codFee: 4000, codMin: 20_000, codMax: 30_000, pendingExpiryMinutes: 30, autoRefundExcessCapture: true } } });
    expect((await g.initiate(await g.body({}, 'COD'))).body.error.code).toBe('COD_NOT_AVAILABLE');
    await seedSettings(prisma); await prisma.setting.update({ where: { key: 'PAYMENT' }, data: { value: { razorpayEnabled: true, codEnabled: true, codFee: 4000, codMin: 20_000, codMax: 500_000, pendingExpiryMinutes: 30, autoRefundExcessCapture: true } } });
    expect(await prisma.order.count({ where: { contactEmail: b.contact.email } })).toBe(0);
    const empty = await request(app()).post('/v1/checkout/initiate').set('Origin', WEB).set('Idempotency-Key', randomUUID()).send(b);
    expect(empty.body.error.code).toBe('CART_EMPTY');
  });

  it('stock taken meanwhile → the cart is lowered to what is left, so the total changed (409 PRICE_CHANGED), stored for the key', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 49_900, onHand: 2 }] });
    const g = await guest(p, 2);
    const b = await g.body();
    const other = await guest(p, 1);
    expect((await other.initiate(await other.body({}, 'COD'))).status).toBe(201);   // someone else bought one
    const key = randomUUID();
    const res = await g.initiate(b, key);
    expect([res.status, res.body.error.code]).toEqual([409, 'PRICE_CHANGED']);
    expect(res.body.error.details.cart.items[0]).toMatchObject({ quantity: 1, warning: 'Only 1 left, so we changed the quantity to 1' });
    const again = await g.initiate(b, key);
    expect([again.status, again.headers['idempotent-replayed']]).toEqual([409, 'true']);
  });
});

describe('acceptance', () => {
  it('AT-01: 20 carts buy the last 5 units at once → exactly 5 orders, reserved = 5, the rest 409; drift views empty', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 49_900, onHand: 5 }] });
    const shoppers = await Promise.all(Array.from({ length: 20 }, () => guest(p)));
    const bodies = await Promise.all(shoppers.map((s) => s.body({}, 'COD')));
    const res = await Promise.all(shoppers.map((s, i) => s.initiate(bodies[i]!)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(5);
    expect(res.filter((r) => r.status !== 201).map((r) => `${r.status} ${r.body.error.code}`)).toEqual(Array(15).fill('409 OUT_OF_STOCK'));
    const v = await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variantIds[0]! } });
    expect([v.onHand, v.reserved]).toEqual([5, 5]);
    expect(await one(prisma, 'SELECT count(*)::int AS n FROM variant_reservation_drift')).toEqual({ n: 0 });
    expect(await one(prisma, 'SELECT count(*)::int AS n FROM product_aggregate_drift')).toEqual({ n: 0 });
  });

  it('AT-02: 10 parallel initiates with one key → one order, the rest replay or REQUEST_IN_PROGRESS; a different body → 422', async () => {
    const p = await liveProduct(prisma);
    const g = await guest(p);
    const b = await g.body();
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 10 }, () => g.initiate(b, key)));
    const ok = res.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.orderNumber)).size).toBe(1);
    for (const r of res.filter((x) => x.status !== 201)) expect([r.status, r.body.error.code]).toEqual([409, 'REQUEST_IN_PROGRESS']);
    const different = await g.initiate({ ...b, customerNote: 'gift wrap' }, key);
    expect([different.status, different.body.error.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    expect(await prisma.order.count({ where: { contactEmail: b.contact.email } })).toBe(1);
    expect(fake.createCalls).toBe(1);
  });

  it('AT-03: Razorpay created the order, the process died before TX2; the retry with the same key adopts it by receipt', async () => {
    const p = await liveProduct(prisma);
    const g = await guest(p);
    const b = await g.body();
    const key = randomUUID();
    fake.next = ['created-then-crash'];
    const crashed = await g.initiate(b, key);
    expect(crashed.status).toBe(500);
    const o = await prisma.order.findFirstOrThrow({ where: { contactEmail: b.contact.email }, include: { paymentAttempts: true } });
    expect(o.paymentAttempts[0]!.status).toBe('CREATING');
    await sleep(1100);   // the 1 s test lock expires → the retry TAKES OVER
    const retry = await g.initiate(b, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body).toMatchObject({ orderNumber: o.orderNumber, razorpay: { orderId: fake.orders[0]!.id } });
    expect([fake.createCalls, await prisma.order.count({ where: { contactEmail: b.contact.email } })]).toEqual([1, 1]);
  });

  it('AT-03 without a retry: the reconciler adopts the provider order by receipt', async () => {
    const p = await liveProduct(prisma);
    const g = await guest(p);
    const b = await g.body();
    fake.next = ['created-then-crash'];
    expect((await g.initiate(b)).status).toBe(500);
    const o = await prisma.order.findFirstOrThrow({ where: { contactEmail: b.contact.email }, include: { paymentAttempts: true } });
    const service = new CheckoutService({ prisma, carts: new CartService(prisma, mediaUrl), provider: fake, mediaUrl, storeName: 'ArtQ' });
    expect(await service.recoverAttempt(o.paymentAttempts[0]!.id)).toBe('CREATED');
    expect(await service.recoverAttempt(o.paymentAttempts[0]!.id)).toBe('UNCHANGED');
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: o.paymentAttempts[0]!.id } }))).toMatchObject({ status: 'CREATED', providerOrderId: fake.orders[0]!.id });
    expect(fake.createCalls).toBe(1);
  });
});
