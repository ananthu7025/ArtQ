// Task 4.1 (rest): abandoned-cart cleanup in the hourly retention job, on real PostgreSQL. Stale guest carts without
// orders are deleted; stale carts that became orders keep their row (the guest's cookie still opens the order) but lose
// items, coupon, pincode and the unverified contact; account carts are kept; nothing with a pending order is touched.
import { randomUUID } from 'node:crypto';
import type { CartStatus, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CartService, hashToken } from '../../src/cart/service.js';
import { runRetention } from '../../src/jobs/retention.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { catalog, order, tx, uniq } from '../helpers/fixtures.js';
import { startPostgres, type Service } from '../helpers/services.js';

let pg: Service, db: TestDb, prisma: PrismaClient, variantId: number, couponId: number;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  variantId = (await tx(prisma, (t) => catalog(t, [[{ price: 1000, onHand: 100 }]]))).products[0]!.variantIds[0]!;
  couponId = (await prisma.coupon.create({ data: { code: `RET${uniq().toUpperCase()}`, title: 'x', type: 'FLAT', value: 500 } })).id;
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });
beforeEach(async () => { await prisma.order.updateMany({ data: { cartId: null } }); await prisma.cart.deleteMany({}); });

async function cart(o: { idleDays: number; status?: CartStatus; userId?: number | null; items?: boolean; extras?: boolean }) {
  const userId = o.userId ?? null;
  const c = await prisma.cart.create({ data: {
    tokenHash: hashToken(randomUUID()), userId, status: o.status ?? 'ACTIVE', lastActivityAt: ago(o.idleDays),
    ...(o.extras ?? true ? { couponId, contactEmail: `g${uniq()}@example.com`, contactPhone: '+919847012345', pincode: '682011' } : {}),
  } });
  if (o.items ?? true) await prisma.cartItem.create({ data: { cartId: c.id, variantId, quantity: 2, addedPrice: 1000 } });
  return c;
}
async function withOrder(cartId: number, status: 'PLACED' | 'PENDING_PAYMENT' | 'EXPIRED' = 'PLACED') {
  const o = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 1 }], reserve: false }));
  await prisma.order.update({ where: { id: o.orderId }, data: { cartId, status } });
  return o;
}
const user = async () => (await prisma.user.create({ data: { email: `u${uniq()}@example.com`, role: 'CUSTOMER', status: 'ACTIVE' } })).id;
const row = (id: number) => prisma.cart.findUnique({ where: { id }, include: { items: true } });

describe('abandoned carts', () => {
  it('a guest cart idle 30 days is kept (exactly at the limit); 31 days without an order → deleted with its items', async () => {
    const fresh = await cart({ idleDays: 29.9 });
    const old = await cart({ idleDays: 31 });
    expect(await runRetention(prisma)).toMatchObject({ cartsDeleted: 1, cartsStripped: 0 });
    expect(await row(fresh.id)).toMatchObject({ status: 'ACTIVE', couponId, items: [{ quantity: 2 }] });
    expect(await row(old.id)).toBeNull();
    expect(await prisma.cartItem.count({ where: { cartId: old.id } })).toBe(0);
    expect(await runRetention(prisma)).toMatchObject({ cartsDeleted: 0, cartsStripped: 0 });   // nothing left to do
  });

  it('a stale cart that became an order keeps its row (and cookie hash) but loses items, coupon, pincode and contact', async () => {
    const converted = await cart({ idleDays: 40, status: 'CONVERTED' });
    const expiredGuest = await cart({ idleDays: 40 });                 // its pending order expired; the cart was still ACTIVE
    const o1 = await withOrder(converted.id);
    await withOrder(expiredGuest.id, 'EXPIRED');
    expect(await runRetention(prisma)).toMatchObject({ cartsDeleted: 0, cartsStripped: 2 });
    expect(await row(converted.id)).toMatchObject({ status: 'CONVERTED', tokenHash: converted.tokenHash, couponId: null, contactEmail: null, contactPhone: null, pincode: null, items: [] });
    expect(await row(expiredGuest.id)).toMatchObject({ status: 'ABANDONED', items: [], couponId: null });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o1.orderId } })).cartId).toBe(converted.id);   // the order still finds its cart
    expect(await runRetention(prisma)).toMatchObject({ cartsStripped: 0 });                                  // already stripped
  });

  it('account carts: the ACTIVE one is kept however old; a MERGED or ABANDONED one is cleaned like a guest cart', async () => {
    const u = await user();
    const active = await cart({ idleDays: 400, userId: u });
    const merged = await cart({ idleDays: 31, status: 'MERGED' });
    const abandonedOwned = await cart({ idleDays: 31, status: 'ABANDONED', userId: await user() });
    expect(await runRetention(prisma)).toMatchObject({ cartsDeleted: 2 });
    expect(await row(active.id)).toMatchObject({ status: 'ACTIVE', items: [{ quantity: 2 }] });
    expect(await row(merged.id)).toBeNull();
    expect(await row(abandonedOwned.id)).toBeNull();
  });

  it('never touches a cart whose order is still waiting for payment', async () => {
    const c = await cart({ idleDays: 45 });
    await withOrder(c.id, 'PENDING_PAYMENT');
    expect(await runRetention(prisma)).toMatchObject({ cartsDeleted: 0, cartsStripped: 0 });
    expect(await row(c.id)).toMatchObject({ status: 'ACTIVE', couponId, items: [{ quantity: 2 }] });
  });

  it('works through a backlog in batches; a cart touched since is spared', async () => {
    const old = await Promise.all(Array.from({ length: 7 }, () => cart({ idleDays: 60, extras: false })));
    const touched = await cart({ idleDays: 60 });
    await prisma.cart.update({ where: { id: touched.id }, data: { lastActivityAt: new Date() } });
    expect(await runRetention(prisma, { batch: 3 })).toMatchObject({ cartsDeleted: 7 });
    expect(await prisma.cart.count({ where: { id: { in: old.map((c) => c.id) } } })).toBe(0);
    expect(await row(touched.id)).not.toBeNull();
  });

  it('changing the cart counts as activity: lowering a quantity or removing an item keeps it from the cleanup', async () => {
    const carts = new CartService(prisma, (k) => k);
    const a = await cart({ idleDays: 31, extras: false });
    const b = await cart({ idleDays: 31, extras: false });
    await prisma.cartItem.create({ data: { cartId: b.id, variantId: (await tx(prisma, (t) => catalog(t, [[{ price: 500, onHand: 5 }]]))).products[0]!.variantIds[0]!, quantity: 1, addedPrice: 500 } });
    const [ia] = await prisma.cartItem.findMany({ where: { cartId: a.id } });
    const [ib] = await prisma.cartItem.findMany({ where: { cartId: b.id }, orderBy: { id: 'asc' } });
    await carts.update(a.id, ia!.id, 1);
    await carts.remove(b.id, ib!.id);
    for (const id of [a.id, b.id]) expect((await row(id))!.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await runRetention(prisma)).toMatchObject({ cartsDeleted: 0 });
  });
});
