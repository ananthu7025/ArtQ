// Task 4.10: order emails from the outbox (customer: placed / expired / refund notice; admin: new order) and the
// confirmation page API (GET /checkout/orders/:n, the guest "Set a password" link), on real PostgreSQL.
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { cookieSpec } from '../../src/auth/cookies.js';
import { verifyLink } from '../../src/auth/tokens.js';
import { cartRouter } from '../../src/cart/routes.js';
import { CartService } from '../../src/cart/service.js';
import { CheckoutService } from '../../src/checkout/initiate.js';
import { checkoutPaymentRouter } from '../../src/checkout/payment-routes.js';
import * as fn from '../../src/db/functions.js';
import { processEmailDelivery, type EmailConsumer, type EmailLinks } from '../../src/email/consumer.js';
import { MemoryTransport } from '../../src/email/transport.js';
import { FakeRazorpay, type PaymentProvider } from '../../src/payments/razorpay.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { startPostgres, type Service } from '../helpers/services.js';
import { liveProduct } from '../helpers/storefront-fixtures.js';

const WEB = 'http://localhost:3000';
const CART = cookieSpec('cart', 'test').name;
const LINKS: EmailLinks = { webUrl: 'https://artq.test', linkSecret: 'test-link-secret-0123456789abcdef0123', setPasswordTtlS: 7 * 86_400 };
const mediaUrl = (k: string) => `https://cdn.test/${k}`;
const log = pino({ level: 'silent' });
let pg: Service, db: TestDb, prisma: PrismaClient, app: Express, kerala: number, mail: MemoryTransport;
let fake: FakeRazorpay;
const provider = new Proxy({} as PaymentProvider, { get: (_t, k) => { const v = (fake as unknown as Record<string | symbol, unknown>)[k]; return typeof v === 'function' ? v.bind(fake) : v; } });

beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  await prisma.setting.update({ where: { key: 'NOTIFY' }, data: { value: { adminEmails: ['owner@artq.in', 'OWNER@artq.in', 'packer@artq.in'], dailySummary: false, lowStockEmail: false } } });
  kerala = (await prisma.state.findFirstOrThrow({ where: { name: 'Kerala' } })).id;
  await prisma.postalCode.create({ data: { pincode: '682011', officeName: 'ERNAKULAM H.O', district: 'ERNAKULAM', stateId: kerala } });
  const checkout = new CheckoutService({ prisma, carts: new CartService(prisma, mediaUrl), provider, mediaUrl, storeName: 'ArtQ' });
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [cartRouter({ prisma, env: 'test', mediaUrl, checkout: { provider, storeName: 'ArtQ', log } }), checkoutPaymentRouter({ prisma, env: 'test', provider, log, checkout, links: LINKS } as Parameters<typeof checkoutPaymentRouter>[0])] } as Parameters<typeof createApp>[0]);
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });
beforeEach(() => { fake = new FakeRazorpay(); mail = new MemoryTransport(); });

async function place(o: { method?: 'COD' | 'RAZORPAY'; email?: string; setPw?: boolean } = {}) {
  const p = await liveProduct(prisma, { name: `Resin <${uniq()}>`, variants: [{ price: 49_900 }] });
  const add = await request(app).post('/v1/cart/items').set('Origin', WEB).send({ variantId: p.variantIds[0], quantity: 2 });
  const cookie = `${CART}=${String(([] as string[]).concat(add.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${CART}=`))).slice(CART.length + 1).split(';')[0]}`;
  const method = o.method ?? 'COD';
  const total = (await request(app).post('/v1/checkout/quote').set('Origin', WEB).set('Cookie', cookie).send({ pincode: '682011', paymentMethod: method })).body.cart.totals.total as number;
  const email = o.email ?? `e${uniq()}@example.com`;
  const res = await request(app).post('/v1/checkout/initiate').set('Origin', WEB).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send({
    contact: { email, phone: '9847012345', sendSetPasswordLink: o.setPw ?? false }, shippingAddress: { fullName: 'Hema Rajan', phone: '9847012345', line1: '12 Rose Villa', landmark: 'SBI', city: 'Kochi', stateId: kerala, pincode: '682011' },
    paymentMethod: method, expectedTotal: total, acceptTerms: true,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const orderNumber = res.body.orderNumber as string;
  return { p, cookie, email, orderNumber, total, providerOrderId: res.body.razorpay?.orderId as string | undefined, get: (path: string) => request(app).get(`/v1${path}`).set('Cookie', cookie), post: (path: string) => request(app).post(`/v1${path}`).set('Origin', WEB).set('Cookie', cookie).send({}) };
}
/** Sends every pending delivery of this order's event for `consumer`. */
async function deliver(eventType: string, aggregateId: string, consumer: EmailConsumer) {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE e.event_type = ${eventType} AND e.aggregate_id = ${aggregateId} AND d.consumer = ${consumer}`;
  expect(rows.length, `${eventType} → ${consumer}`).toBeGreaterThan(0);
  for (const r of rows) await processEmailDelivery({ prisma, transport: mail, from: 'ArtQ <no-reply@artq.in>', log, links: LINKS }, consumer, Number(r.id));
}

describe('order emails', () => {
  it('COD placed: the customer gets the order (items, totals with shipping and the COD fee, address, delivery days); the owner gets one email per address', async () => {
    const g = await place();
    await deliver('order.placed', g.orderNumber, 'email.customer');
    const m = mail.sent.find((x) => x.to === g.email)!;
    expect(m.subject).toBe(`Order ${g.orderNumber} placed`);
    expect(m.text).toContain('Hi Hema, thank you for your order');
    expect(m.text).toContain(`2 × ${g.p.name} (100 gm): ₹998`);
    expect(m.text).toContain(`keep ₹${(g.total / 100).toLocaleString('en-IN')} ready`);
    expect(m.html).toContain('Resin &lt;');
    expect(m.html).toContain('Cash on delivery fee');
    expect(m.html).toContain('Near SBI');
    expect(m.text).toContain('4–7 days');
    expect(m.html).not.toContain('Set a password');
    await deliver('order.placed', g.orderNumber, 'email.admin');
    const admin = mail.sent.filter((x) => x.subject.startsWith(`[ArtQ] New order ${g.orderNumber}`));
    expect(admin.map((x) => x.to).sort()).toEqual(['owner@artq.in', 'packer@artq.in']);
    expect(admin[0]!.text).toContain('cash on delivery, 2 item(s), Hema Rajan, Kochi');
    await deliver('order.placed', g.orderNumber, 'email.customer');   // a repeat delivery sends nothing new
    expect(mail.sent.filter((x) => x.to === g.email)).toHaveLength(1);
  });

  it('a guest who asked for it gets a working set-password link in the order email; not when the email already has a password', async () => {
    const g = await place({ setPw: true });
    await deliver('order.placed', g.orderNumber, 'email.customer');
    const m = mail.sent.find((x) => x.to === g.email)!;
    const link = /https:\/\/artq\.test\/set-password\?token=([^"\s]+)/.exec(m.html)![1]!;
    expect(verifyLink(LINKS.linkSecret, 'set_password', decodeURIComponent(link))).toMatchObject({ e: g.email });
    const known = `known${uniq()}@example.com`;
    await prisma.user.create({ data: { email: known, role: 'CUSTOMER', status: 'ACTIVE', passwordHash: 'x' } });
    const h = await place({ setPw: true, email: known });
    await deliver('order.placed', h.orderNumber, 'email.customer');
    expect(mail.sent.find((x) => x.to === known)!.html).not.toContain('Set a password');
  });

  it('online: paid → "payment confirmed" email; expired unpaid → "not completed"; paid twice → refund notice for the extra payment', async () => {
    const g = await place({ method: 'RAZORPAY' });
    await fn.applyProviderPayment(prisma, { providerOrderId: g.providerOrderId!, paymentId: `pay_${uniq()}`, amount: g.total, currency: 'INR', status: 'CAPTURED', amountRefunded: 0, capturedAt: new Date(), method: 'upi', raw: {}, actor: 'WEBHOOK' });
    await deliver('order.placed', g.orderNumber, 'email.customer');
    expect(mail.sent.at(-1)!.text).toContain('Your payment is confirmed.');
    await fn.applyProviderPayment(prisma, { providerOrderId: g.providerOrderId!, paymentId: `pay_${uniq()}`, amount: g.total, currency: 'INR', status: 'CAPTURED', amountRefunded: 0, capturedAt: new Date(), method: 'upi', raw: {}, actor: 'WEBHOOK' });
    await deliver('payment.refund_notice', g.orderNumber, 'email.customer');
    expect(mail.sent.at(-1)!.text).toContain(`We received two payments for order ${g.orderNumber}. The extra payment of ₹${(g.total / 100).toLocaleString('en-IN')} is being refunded.`);

    const h = await place({ method: 'RAZORPAY' });
    const o = await prisma.order.findUniqueOrThrow({ where: { orderNumber: h.orderNumber } });
    await prisma.$transaction((tx) => fn.releaseUnpaidOrder(tx, { orderId: o.id, newStatus: 'EXPIRED', reason: 'timeout', actor: 'SYSTEM' }));
    await deliver('order.expired', h.orderNumber, 'email.customer');
    expect(mail.sent.at(-1)).toMatchObject({ to: h.email, subject: `Order ${h.orderNumber} was not completed` });
  });
});

describe('confirmation page API', () => {
  it('the order as placed: items, totals, address, delivery days, payment method; only for the browser that placed it', async () => {
    const g = await place();
    const res = await g.get(`/checkout/orders/${g.orderNumber}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toEqual({
      orderNumber: g.orderNumber, status: 'PLACED', paymentStatus: 'COD_PENDING', displayStatus: 'Order placed', paymentMethod: 'COD', firstName: 'Hema', contactEmail: g.email,
      items: [{ name: g.p.name, label: '100 gm', quantity: 2, lineTotal: 99_800, imageUrl: expect.any(String) }],
      totals: { subtotal: 99_800, couponDiscount: 0, couponCode: null, shipping: 7000, codFee: 4000, total: g.total },
      address: { name: 'Hema Rajan', lines: ['12 Rose Villa', 'Near SBI', 'Kochi, Kerala 682011'] }, estimatedDays: { min: 4, max: 7 }, canSetPassword: true,
    });
    expect((await request(app).get(`/v1/checkout/orders/${g.orderNumber}`)).status).toBe(404);
  });

  it('"Set a password": one email to the order address, then quiet for 10 minutes; nothing for a pending order or an email with a password', async () => {
    const g = await place();
    expect((await g.post(`/checkout/orders/${g.orderNumber}/set-password-link`)).body).toEqual({ sent: true });
    expect((await g.post(`/checkout/orders/${g.orderNumber}/set-password-link`)).body).toEqual({ sent: true });
    const events = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'email.auth' AND payload->>'to' = ${g.email} AND payload->>'template' = 'set_password_link'`;
    expect(events[0]!.n).toBe(1);
    const pending = await place({ method: 'RAZORPAY' });
    expect((await pending.get(`/checkout/orders/${pending.orderNumber}`)).body).toMatchObject({ status: 'PENDING_PAYMENT', displayStatus: 'Awaiting payment', canSetPassword: false });
    await pending.post(`/checkout/orders/${pending.orderNumber}/set-password-link`);
    const none = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'email.auth' AND payload->>'to' = ${pending.email}`;
    expect(none[0]!.n).toBe(0);
  });
});
