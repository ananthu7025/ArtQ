// Task 1.10: Idempotency-Key middleware on a stand-in checkout endpoint that creates and reserves a real order through
// the aq_* functions. ✅ AT-02: 10 parallel initiates with the same key + 1 with a different body → one order; the 9 others
// get a replay or REQUEST_IN_PROGRESS; the different body → 422.
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Router, type Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { DbFunctionError } from '../../src/db/errors.js';
import * as fn from '../../src/db/functions.js';
import { idempotent } from '../../src/idempotency/idempotency.js';
import { loadResume, ResumeTargetMissingError } from '../../src/idempotency/resume.js';
import { runRetention } from '../../src/jobs/retention.js';
import { AppError } from '../../src/lib/errors.js';
import { validate } from '../../src/middleware/validate.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { attempt, capture, catalog, order, tx } from '../helpers/fixtures.js';
import { startPostgres, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:3000';
let pg: Service, db: TestDb, prisma: PrismaClient, variantId: number;

type Hooks = { afterAttach?: () => Promise<void>; beforeAttach?: () => Promise<void> };
const hooks: Hooks = {};
const executions: string[] = [];

function build(lockSeconds = 60): Express {
  const r = Router();
  const deps = { prisma, log: pino({ level: 'silent' }) };
  r.post('/test/carts/:cartId/initiate', validate({ params: z.strictObject({ cartId: z.coerce.number().int() }), body: z.strictObject({ qty: z.number().int().positive().default(1), note: z.string().optional() }) }),
    idempotent(deps, { operation: 'checkout.initiate', scope: (req) => `user:${req.get('x-test-user') ?? 'guest'}`, target: (req) => `cart:${(req.params as unknown as { cartId: number }).cartId}`, lockSeconds }, async (req, ctx) => {
      if (ctx.resume) {
        const resumed = await loadResume(prisma, ctx.resume);
        if (resumed.kind !== 'order') throw new Error('unexpected resource');
        executions.push(`resume:${resumed.orderNumber}`);
        return { status: 201, body: { orderNumber: resumed.orderNumber, resumed: true }, resource: { type: 'order', id: resumed.orderNumber } };
      }
      executions.push('create');
      const o = await ctx.tx(async (t) => {
        await hooks.beforeAttach?.();
        let created;
        try {
          created = await order(t, { lines: [{ variantId, qty: (req.body as { qty: number }).qty }] });
        } catch (e) {
          if (e instanceof DbFunctionError && e.code === 'OUT_OF_STOCK') throw new AppError(409, 'OUT_OF_STOCK', 'Not enough stock', { variantId });
          throw e;
        }
        await ctx.attach(t, 'order', created.orderNumber);
        return created;
      });
      await hooks.afterAttach?.();
      // TX2 (like checkout's provider-order update): its first statement proves ownership, so a superseded owner writes nothing.
      const marker = req.get('x-test-marker');
      if (marker) await ctx.tx(async (t) => { await t.$executeRaw`INSERT INTO settings (key, value, updated_at) VALUES (${marker}, '{}', now())`; });
      await ctx.renew();                                            // e.g. before the provider call
      return { status: 201, body: { orderNumber: o.orderNumber }, resource: { type: 'order', id: o.orderNumber } };
    }));
  return createApp({ version: 't', origins: { storefront: [ORIGIN], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} }, routes: [r] });
}

beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  const cat = await catalog(prisma, [[{ price: 10_000, onHand: 1000 }]]);
  variantId = cat.products[0]!.variantIds[0]!;
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });
beforeEach(() => { delete hooks.afterAttach; delete hooks.beforeAttach; executions.length = 0; });

const initiate = (a: Express, cartId: number, body: object, key: string | null, user = '7', marker?: string) => {
  let r = request(a).post(`/v1/test/carts/${cartId}/initiate`).set('Origin', ORIGIN).set('X-Test-User', user);
  if (marker) r = r.set('X-Test-Marker', marker);
  if (key !== null) r = r.set('Idempotency-Key', key);
  return r.send(body);
};
const orders = () => prisma.order.count();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AT-02: concurrent repeated keys', () => {
  it('10 parallel requests with one key + 1 with a different body → one order; 9 replay or 409; the different body → 422', async () => {
    const app = build();
    const key = randomUUID();
    const before = await orders();
    hooks.afterAttach = () => sleep(300);                            // keep the first request in flight while the others arrive
    const same = Array.from({ length: 10 }, () => initiate(app, 1, { qty: 1 }, key));
    const different = initiate(app, 1, { qty: 2 }, key);
    const rs = await Promise.all([...same, different]);
    const diff = rs.pop()!;
    expect(await orders()).toBe(before + 1);
    expect(executions).toEqual(['create']);
    const created = rs.filter((r) => r.status === 201 && !r.headers['idempotent-replayed']);
    const replays = rs.filter((r) => r.status === 201 && r.headers['idempotent-replayed'] === 'true');
    const inProgress = rs.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(replays.length + inProgress.length).toBe(9);
    for (const r of inProgress) expect(r).toMatchObject({ body: { error: { code: 'REQUEST_IN_PROGRESS' } }, headers: { 'retry-after': '2' } });
    for (const r of replays) expect(r.body).toEqual(created[0]!.body);
    expect(diff.status).toBe(422);
    expect(diff.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // after completion every retry is a replay of the same response
    const again = await initiate(app, 1, { qty: 1 }, key);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(created[0]!.body);
  });
});

describe('keys, scopes and targets', () => {
  it('the key is required and must be a UUID', async () => {
    const app = build();
    for (const k of [null, 'not-a-uuid', '123', `${randomUUID()}x`]) {
      const r = await initiate(app, 1, { qty: 1 }, k);
      expect(r.status).toBe(400);
      expect(r.body.error.details[0]).toMatchObject({ location: 'headers', path: 'idempotency-key' });
    }
  });

  it('same key + same body against a DIFFERENT cart is a conflict, never a replay of the first order (C10)', async () => {
    const app = build();
    const key = randomUUID();
    expect((await initiate(app, 1, { qty: 1 }, key)).status).toBe(201);
    const r = await initiate(app, 2, { qty: 1 }, key);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('the same key in another scope (another customer) is independent', async () => {
    const app = build();
    const key = randomUUID();
    const a = await initiate(app, 1, { qty: 1 }, key, '7');
    const b = await initiate(app, 1, { qty: 1 }, key, '8');
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.orderNumber).not.toBe(b.body.orderNumber);
  });

  it('upper-case and lower-case spellings of a key are the same key; defaults count as part of the body', async () => {
    const app = build();
    const key = randomUUID();
    const first = await initiate(app, 1, {}, key.toUpperCase());                 // qty defaults to 1
    const second = await initiate(app, 1, { qty: 1 }, key);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
  });
});

describe('outcomes are remembered', () => {
  it('a business error (OUT_OF_STOCK) is stored and replayed, even after stock comes back', async () => {
    const app = build();
    const key = randomUUID();
    const r = await initiate(app, 1, { qty: 5000 }, key);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'OUT_OF_STOCK', details: { variantId } });
    await prisma.$executeRaw`UPDATE product_variants SET on_hand = on_hand + 10000 WHERE id = ${variantId}`;
    const again = await initiate(app, 1, { qty: 5000 }, key);
    expect(again.status).toBe(409);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(r.body);
    expect(executions).toEqual(['create']);
    await prisma.$executeRaw`UPDATE product_variants SET on_hand = on_hand - 10000 WHERE id = ${variantId}`;
  });

  it('an unexpected crash before anything was attached releases the key: an immediate retry runs', async () => {
    const app = build();
    const key = randomUUID();
    hooks.beforeAttach = async () => { delete hooks.beforeAttach; throw new Error('database hiccup'); };
    expect((await initiate(app, 1, { qty: 1 }, key)).status).toBe(500);
    const retry = await initiate(app, 1, { qty: 1 }, key);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(executions).toEqual(['create', 'create']);
  });

  it('a crash after the order was attached keeps the key: retry → 409 while locked, then TAKEOVER resumes the same order', async () => {
    const app = build(1);
    const key = randomUUID();
    const before = await orders();
    hooks.afterAttach = async () => { delete hooks.afterAttach; throw new Error('provider timeout'); };
    expect((await initiate(app, 1, { qty: 1 }, key)).status).toBe(500);
    expect(await orders()).toBe(before + 1);
    expect((await initiate(app, 1, { qty: 1 }, key)).body.error.code).toBe('REQUEST_IN_PROGRESS');
    await sleep(1100);
    const resumed = await initiate(app, 1, { qty: 1 }, key);
    expect(resumed.status).toBe(201);
    expect(resumed.body.resumed).toBe(true);
    expect(await orders()).toBe(before + 1);                          // never a second order
    expect(executions).toEqual(['create', 'resume:' + resumed.body.orderNumber]);
  });
});

describe('ownership fencing', () => {
  it('a stalled owner is superseded: the retry resumes, the original gets 409 REQUEST_SUPERSEDED, and a later retry replays', async () => {
    const app = build(1);
    const key = randomUUID();
    const before = await orders();
    let release!: () => void;
    hooks.afterAttach = () => new Promise<void>((r) => { release = r; });           // original stalls after attaching
    const marker = `idem-stale-${key}`;
    const original = initiate(app, 1, { qty: 1 }, key, '7', marker).then((r) => r);  // .then() sends it now (supertest is lazy)
    await sleep(1300);                                                               // its 1 s lock expires
    delete hooks.afterAttach;
    const takeover = await initiate(app, 1, { qty: 1 }, key);
    expect(takeover.status).toBe(201);
    expect(takeover.body.resumed).toBe(true);
    release();
    const late = await original;
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('REQUEST_SUPERSEDED');
    expect(await prisma.setting.count({ where: { key: marker } })).toBe(0);       // its TX2 was rolled back
    expect(await orders()).toBe(before + 1);
    const retry = await initiate(app, 1, { qty: 1 }, key);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(takeover.body);
  });

  it("a superseded owner's transaction is rolled back entirely (assert_owner is its first statement)", async () => {
    const key = randomUUID();
    const k = { scope: 'user:9', operation: 'checkout.initiate', key };
    const first = await fn.idempotencyBegin(prisma, { ...k, target: 'cart:9', requestHash: 'a'.repeat(64), lockSeconds: 0 });
    const second = await fn.idempotencyBegin(prisma, { ...k, target: 'cart:9', requestHash: 'a'.repeat(64) });
    expect([first.outcome, second.outcome]).toEqual(['NEW', 'TAKEOVER']);
    const before = await orders();
    const stale = prisma.$transaction(async (t) => {
      await fn.idempotencyAssertOwner(t, { ...k, ownerToken: (first as { ownerToken: string }).ownerToken });
      await order(t, { lines: [{ variantId, qty: 1 }] });
    });
    await expect(stale).rejects.toMatchObject({ code: 'IDEMPOTENCY_OWNERSHIP_LOST' });
    expect(await orders()).toBe(before);
  });
});

describe('resume loaders and purge', () => {
  it('order (with its open attempt), payment attempt and refund; missing or unknown targets fail loudly', async () => {
    const o = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 1 }] }));
    const a = await attempt(prisma, o.orderId, o.total);
    expect(await loadResume(prisma, { resourceType: 'order', resourceId: o.orderNumber })).toMatchObject({ kind: 'order', orderId: o.orderId, status: 'PENDING_PAYMENT', openAttempt: { id: a.attemptId, status: 'CREATED' } });
    expect(await loadResume(prisma, { resourceType: 'payment_attempt', resourceId: String(a.attemptId) })).toMatchObject({ kind: 'payment_attempt', attempt: { orderId: o.orderId } });
    await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: `pay_${randomUUID().slice(0, 8)}`, amount: o.total }));
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: o.orderId } });
    const refundId = await tx(prisma, (t) => fn.requestRefund(t, { orderId: o.orderId, paymentId: pay.id, kind: 'CANCELLATION', items: [{ orderItemId: o.items[0]!.orderItemId, quantity: 1, amount: 10_000 }], shipping: 0, codFee: 0, unallocated: 0, reason: 'r', idempotencyKey: randomUUID(), requestedBy: null }));
    expect(await loadResume(prisma, { resourceType: 'refund', resourceId: String(refundId) })).toMatchObject({ kind: 'refund', refund: { id: refundId, attemptNo: 1 }, latestAttempt: { attemptNo: 1, providerIdempotencyKey: `artq-refund-${refundId}-a1` } });
    await expect(loadResume(prisma, { resourceType: 'order', resourceId: 'AQ-NOPE' })).rejects.toBeInstanceOf(ResumeTargetMissingError);
    await expect(loadResume(prisma, { resourceType: 'refund', resourceId: 'x' })).rejects.toBeInstanceOf(ResumeTargetMissingError);
    await expect(loadResume(prisma, { resourceType: 'coupon', resourceId: '1' })).rejects.toThrow(/no resume loader/);
  });

  it('records older than 24 hours are purged by the retention job; fresh ones stay', async () => {
    const app = build();
    const oldKey = randomUUID();
    const freshKey = randomUUID();
    await initiate(app, 1, { qty: 1 }, oldKey);
    await initiate(app, 1, { qty: 1 }, freshKey);
    await prisma.$executeRaw`UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = ${oldKey}`;
    expect((await runRetention(prisma)).idempotencyKeys).toBe(1);
    expect(await prisma.idempotencyKey.count({ where: { key: { in: [oldKey, freshKey] } } })).toBe(1);
    expect((await initiate(app, 1, { qty: 1 }, freshKey)).headers['idempotent-replayed']).toBe('true');
  });
});
