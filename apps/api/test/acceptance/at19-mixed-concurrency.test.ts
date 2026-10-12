// ✅ AT-19 (task 7.1): at concurrency ≥ 20, all at once — multi-variant checkouts, their releases (the expiry job),
// inventory count imports (multi-row adjustments, the same stock function the count-sheet import applies), catalogue
// variant edits and price changes, taxonomy renames, and the search worker. Real routes on PostgreSQL. Pass: no
// deadlocks (40P01, counted by PostgreSQL itself) and no server errors; reservation and aggregate drift empty; every
// product's search vector current once the queue drains (C09 at database level).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fn from '../../src/db/functions.js';
import { expirePending } from '../../src/payments/reconcile.js';
import { createAcceptanceApp, WEB, type AcceptanceApp } from '../helpers/acceptance-app.js';
import { liveProduct } from '../helpers/storefront-fixtures.js';

let t: AcceptanceApp;
beforeAll(async () => { t = await createAcceptanceApp(); }, 180_000);
afterAll(async () => { await t?.close(); });

const deadlocks = async () => Number((await t.prisma.$queryRaw<{ n: bigint }[]>`SELECT deadlocks AS n FROM pg_stat_database WHERE datname = current_database()`)[0]!.n);
const rnd = (n: number) => Math.floor(Math.random() * n);
const shuffle = <T,>(a: T[]) => a.map((x) => [Math.random(), x] as const).sort((p, q) => p[0] - q[0]).map(([, x]) => x);

describe('AT-19: everything at once', () => {
  it('24 workers × mixed operations: no deadlocks, no 5xx, no drift; search vectors current after the queue drains', async () => {
    const first = await liveProduct(t.prisma, { variants: [{ price: 30_000, onHand: 400 }, { price: 31_000, onHand: 400 }, { price: 32_000, onHand: 400 }] });
    const products = [first, ...await Promise.all([1, 2, 3, 4, 5].map(() => liveProduct(t.prisma, { typeId: first.typeId, categoryId: first.categoryId, variants: [{ price: 30_000, onHand: 400 }, { price: 31_000, onHand: 400 }, { price: 32_000, onHand: 400 }] })))];
    const variants = products.flatMap((p) => p.variantIds);
    const before = await deadlocks();
    const statuses = new Map<string, number[]>();
    const note = (kind: string, status: number) => statuses.set(kind, [...(statuses.get(kind) ?? []), status]);

    const checkout = async () => {
      const add = await request(t.app).post('/v1/cart/items').set('Origin', WEB).send({ variantId: variants[rnd(variants.length)] });
      const cookie = String(([] as string[]).concat(add.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0]!;
      for (const v of shuffle(variants).slice(0, 2)) await request(t.app).post('/v1/cart/items').set('Origin', WEB).set('Cookie', cookie).send({ variantId: v });
      const quote = await request(t.app).post('/v1/checkout/quote').set('Origin', WEB).set('Cookie', cookie).send({ pincode: '682011' });
      if (quote.status !== 200) return note('quote', quote.status);
      const res = await request(t.app).post('/v1/checkout/initiate').set('Origin', WEB).set('Cookie', cookie).set('Idempotency-Key', crypto.randomUUID()).send({
        contact: { email: `at19-${rnd(1e9)}@example.com`, phone: '9847012345' }, shippingAddress: { fullName: 'Hema R', phone: '9847012345', line1: '12 Rose Villa', city: 'Kochi', stateId: t.kerala, pincode: '682011' },
        paymentMethod: 'RAZORPAY', expectedTotal: quote.body.cart.totals.total, acceptTerms: true,
      });
      note('checkout', res.status);
      if (res.status === 201 && rnd(2) === 0) await t.prisma.order.update({ where: { orderNumber: res.body.orderNumber }, data: { expiresAt: new Date(Date.now() - 1000) } });   // this one will be released
    };
    const release = async () => { await expirePending(t.deps()); note('release', 200); };
    const countImport = async () => {
      const rows = shuffle(variants).slice(0, 6).map((variantId) => ({ variantId, kind: 'RECOUNT', quantity: 300 + rnd(100) }));
      note('import', (await t.adminCall('post', '/inventory/adjustments', { rows })).status);
    };
    const variantEdit = async () => {
      const id = variants[rnd(variants.length)]!;
      const v = await t.prisma.productVariant.findUniqueOrThrow({ where: { id } });
      const res = rnd(2) ? await t.adminCall('patch', `/variants/${id}/pricing`, { price: 30_000 + rnd(5000), mrp: null, version: v.version })
        : await t.adminCall('patch', `/variants/${id}`, { version: v.version, sortOrder: rnd(50) });
      note('variant', res.status);
    };
    const rename = async (i: number) => {
      const res = rnd(2) ? await t.adminCall('patch', `/categories/${first.categoryId}`, { name: `Resin moulds ${i}` })
        : await t.adminCall('patch', `/product-types/${first.typeId}`, { name: `Resin art ${i}` });
      note('rename', res.status);
    };
    const search = async () => { await t.prisma.$transaction((tx) => fn.processSearchQueue(tx)); note('search', 200); };

    let n = 0;
    const worker = async (w: number) => {
      while (n < 240) {
        const i = n++;
        const ops = [checkout, checkout, checkout, release, countImport, variantEdit, variantEdit, () => rename(i), search];
        await ops[(i + w) % ops.length]!();
      }
    };
    await Promise.all(Array.from({ length: 24 }, (_, w) => worker(w)));

    const all = [...statuses.values()].flat();
    expect(all.filter((s) => s >= 500)).toEqual([]);
    expect(statuses.get('checkout')!.filter((s) => ![201, 409, 422].includes(s))).toEqual([]);   // placed, or refused cleanly (stock, price changed)
    expect(statuses.get('checkout')!.filter((s) => s === 201).length).toBeGreaterThan(0);
    expect(statuses.get('import')!.every((s) => s === 200)).toBe(true);
    expect(statuses.get('rename')!.filter((s) => ![200, 409].includes(s))).toEqual([]);
    expect(statuses.get('variant')!.filter((s) => ![200, 409].includes(s))).toEqual([]);   // 409 = someone else saved first (version)
    expect(await deadlocks()).toBe(before);

    expect(await t.prisma.$queryRaw<unknown[]>`SELECT * FROM variant_reservation_drift`).toEqual([]);
    expect(await t.prisma.$queryRaw<unknown[]>`SELECT * FROM product_aggregate_drift`).toEqual([]);
    while ((await t.prisma.$transaction((tx) => fn.processSearchQueue(tx))) > 0) { /* drain */ }
    const stale = await t.prisma.$queryRaw<{ id: number }[]>`SELECT p.id FROM products p WHERE p.search_vector IS DISTINCT FROM product_search_vector(p)`;
    expect(stale).toEqual([]);
    const renamed = await t.prisma.category.findUniqueOrThrow({ where: { id: first.categoryId } });
    expect((await t.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM products WHERE search_vector @@ plainto_tsquery('simple', ${renamed.name})`)[0]!.n).toBe(BigInt(products.length));
  }, 180_000);
});
