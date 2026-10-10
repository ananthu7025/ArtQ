// Admin Coupons module (api.md §4.8, product.md §7 "Coupons", task 4.3); every route needs coupons:write. Create/edit
// with the shared couponBody; changing the discount (type or value) of a coupon that has been used is refused (create a
// new coupon instead), so every order's coupon rule stays what the customer was shown. Delete is a soft delete.
import { couponBody, couponListQuery, type CouponAdminView, type CouponData, type CouponState, type Permission, type RedemptionView } from '@artq/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import type { CouponWithTargets } from './service.js';

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive() });
const pageQuery = z.strictObject({ page: z.coerce.number().int().min(1).max(10_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) });
const TARGET_TYPE = { TYPES: 'TYPE', CATEGORIES: 'CATEGORY', PRODUCTS: 'PRODUCT' } as const;

const field = (path: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path, message }]);
const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');

export function couponState(c: { isActive: boolean; startsAt: Date | null; endsAt: Date | null }, now = new Date()): CouponState {
  if (!c.isActive) return 'inactive';
  if (c.endsAt && c.endsAt <= now) return 'expired';
  if (c.startsAt && c.startsAt > now) return 'scheduled';
  return 'active';
}

export function registerCouponRoutes(admin: AdminRoutes, prisma: PrismaClient): void {
  const r = admin.routes;
  const can = admin.can('coupons:write');

  /** Names for the targets of many coupons at once. */
  const targetNames = async (coupons: CouponWithTargets[]) => {
    const ids = (t: string) => [...new Set(coupons.flatMap((c) => c.targets.filter((x) => x.targetType === t).map((x) => x.targetId)))];
    const [types, cats, products] = await Promise.all([
      prisma.productType.findMany({ where: { id: { in: ids('TYPE') } }, select: { id: true, name: true } }),
      prisma.category.findMany({ where: { id: { in: ids('CATEGORY') } }, select: { id: true, name: true } }),
      prisma.product.findMany({ where: { id: { in: ids('PRODUCT') } }, select: { id: true, name: true } }),
    ]);
    const names = { TYPE: new Map(types.map((t) => [t.id, t.name])), CATEGORY: new Map(cats.map((t) => [t.id, t.name])), PRODUCT: new Map(products.map((t) => [t.id, t.name])) };
    return (c: CouponWithTargets) => c.targets.map((t) => ({ id: t.targetId, name: names[t.targetType as keyof typeof names].get(t.targetId) ?? `#${t.targetId}` }));
  };
  const used = async (ids: number[]) => new Set((await prisma.couponRedemption.groupBy({ by: ['couponId'], where: { couponId: { in: ids } } })).map((g) => g.couponId));
  const views = async (list: CouponWithTargets[]): Promise<CouponAdminView[]> => {
    const [names, inUse] = await Promise.all([targetNames(list), used(list.map((c) => c.id))]);
    return list.map((c) => ({
      id: c.id, code: c.code, title: c.title, description: c.description, type: c.type, value: c.value, maxDiscount: c.maxDiscount, minOrderValue: c.minOrderValue,
      startsAt: c.startsAt?.toISOString() ?? null, endsAt: c.endsAt?.toISOString() ?? null, usageLimitTotal: c.usageLimitTotal, usageLimitPerCustomer: c.usageLimitPerCustomer,
      reservedCount: c.reservedCount, redeemedCount: c.redeemedCount, firstOrderOnly: c.firstOrderOnly, isPublic: c.isPublic, isActive: c.isActive,
      appliesTo: c.appliesTo, targets: names(c), state: couponState(c), hasRedemptions: inUse.has(c.id), updatedAt: c.updatedAt.toISOString(),
    }));
  };
  const load = async (id: number) => {
    const c = await prisma.coupon.findFirst({ where: { id, deletedAt: null }, include: { targets: true } });
    if (!c) throw new AppError(404, 'NOT_FOUND', 'Coupon not found');
    return c;
  };

  /** Every target must exist (products: not deleted). */
  const checkTargets = async (b: CouponData) => {
    if (b.appliesTo === 'ALL') return;
    const where = { id: { in: b.targetIds } };
    const found = b.appliesTo === 'TYPES' ? await prisma.productType.count({ where })
      : b.appliesTo === 'CATEGORIES' ? await prisma.category.count({ where })
        : await prisma.product.count({ where: { ...where, deletedAt: null } });
    if (found !== b.targetIds.length) throw field('targetIds', 'Some of these no longer exist. Choose again.');
  };
  const columns = (b: CouponData) => ({
    code: b.code, title: b.title, description: b.description ?? null, type: b.type, value: b.value, maxDiscount: b.maxDiscount, minOrderValue: b.minOrderValue,
    startsAt: b.startsAt ? new Date(b.startsAt) : null, endsAt: b.endsAt ? new Date(b.endsAt) : null, usageLimitTotal: b.usageLimitTotal,
    usageLimitPerCustomer: b.usageLimitPerCustomer, firstOrderOnly: b.firstOrderOnly, isPublic: b.isPublic, isActive: b.isActive, appliesTo: b.appliesTo,
  });
  const targets = (b: CouponData) => (b.appliesTo === 'ALL' ? [] : b.targetIds.map((targetId) => ({ targetType: TARGET_TYPE[b.appliesTo as keyof typeof TARGET_TYPE], targetId })));
  const codeTaken = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' ? field('code', 'Another coupon (or a deleted one) uses this code') : e;

  r.get('/coupons', can, validate({ query: couponListQuery }), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof couponListQuery>;
    const now = new Date();
    const state: Prisma.CouponWhereInput = q.state === 'inactive' ? { isActive: false }
      : q.state === 'expired' ? { isActive: true, endsAt: { lte: now } }
        : q.state === 'scheduled' ? { isActive: true, startsAt: { gt: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] }
          : q.state === 'active' ? { isActive: true, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] } : {};
    const where: Prisma.CouponWhereInput = { deletedAt: null, ...state, ...(q.q ? { AND: [...((state.AND as Prisma.CouponWhereInput[]) ?? []), { OR: [{ code: { contains: q.q, mode: 'insensitive' } }, { title: { contains: q.q, mode: 'insensitive' } }] }] } : {}) };
    const [total, list] = await Promise.all([
      prisma.coupon.count({ where }),
      prisma.coupon.findMany({ where, include: { targets: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    noStore(res).json({ data: await views(list), meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } });
  });

  r.get('/coupons/:id', can, validate({ params: idParam }), async (req, res) => {
    noStore(res).json((await views([await load((req.params as unknown as { id: number }).id)]))[0]);
  });

  r.post('/coupons', can, validate({ body: couponBody }), async (req: Request, res) => {
    const b = req.body as CouponData;
    await checkTargets(b);
    const created = await prisma.$transaction(async (tx) => {
      const c = await tx.coupon.create({ data: { ...columns(b), createdBy: req.auth!.userId, targets: { create: targets(b) } }, include: { targets: true } });
      await recordAudit(tx, req, res, { action: 'coupon.create', entity: 'coupon', entityId: c.id, after: { ...columns(b), targetIds: b.targetIds } });
      return c;
    }).catch((e: unknown) => { throw codeTaken(e); });
    noStore(res).status(201).json((await views([created]))[0]);
  });

  r.put('/coupons/:id', can, validate({ params: idParam, body: couponBody }), async (req, res) => {
    const id = (req.params as unknown as { id: number }).id;
    const b = req.body as CouponData;
    await checkTargets(b);
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${id} FOR NO KEY UPDATE`;   // counters move under this lock too
      const before = await tx.coupon.findFirst({ where: { id, deletedAt: null }, include: { targets: true } });
      if (!before) throw new AppError(404, 'NOT_FOUND', 'Coupon not found');
      const inUse = (await tx.couponRedemption.count({ where: { couponId: id } })) > 0;
      if (inUse && (before.type !== b.type || before.value !== b.value)) {
        throw new AppError(409, 'COUPON_IN_USE', 'This coupon has been used, so its discount cannot change. Create a new coupon instead.');
      }
      const taken = before.reservedCount + before.redeemedCount;
      if (b.usageLimitTotal !== null && b.usageLimitTotal < taken) throw field('usageLimitTotal', `Use at least ${taken} (already used or held at checkout)`);
      await tx.couponTarget.deleteMany({ where: { couponId: id } });
      const c = await tx.coupon.update({ where: { id }, data: { ...columns(b), targets: { create: targets(b) } }, include: { targets: true } });
      await recordAudit(tx, req, res, { action: 'coupon.update', entity: 'coupon', entityId: id, before: { ...before, targets: undefined, targetIds: before.targets.map((t) => t.targetId) }, after: { ...columns(b), targetIds: b.targetIds } });
      return c;
    }).catch((e: unknown) => { throw codeTaken(e); });
    noStore(res).json((await views([updated]))[0]);
  });

  /** Soft delete: the coupon stops working at once; orders and redemptions keep pointing at it. */
  r.delete('/coupons/:id', can, validate({ params: idParam }), async (req, res) => {
    const id = (req.params as unknown as { id: number }).id;
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.coupon.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), isActive: false } });
      if (count === 0) throw new AppError(404, 'NOT_FOUND', 'Coupon not found');
      await recordAudit(tx, req, res, { action: 'coupon.delete', entity: 'coupon', entityId: id });
    });
    noStore(res).json({ ok: true });
  });

  r.get('/coupons/:id/redemptions', can, validate({ params: idParam, query: pageQuery }), async (req, res) => {
    const id = (req.params as unknown as { id: number }).id;
    const q = req.query as unknown as z.infer<typeof pageQuery>;
    await load(id);
    const [total, rows] = await Promise.all([
      prisma.couponRedemption.count({ where: { couponId: id } }),
      prisma.couponRedemption.findMany({ where: { couponId: id }, include: { order: { select: { orderNumber: true } } }, orderBy: [{ reservedAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    const data: RedemptionView[] = rows.map((x) => ({
      id: x.id, status: x.status, overLimit: x.overLimit, discount: x.discount, orderNumber: x.order.orderNumber, customer: { userId: x.userId, email: x.customerEmail },
      reservedAt: x.reservedAt.toISOString(), redeemedAt: x.redeemedAt?.toISOString() ?? null, releasedAt: x.releasedAt?.toISOString() ?? null, reversedAt: x.reversedAt?.toISOString() ?? null,
    }));
    noStore(res).json({ data, meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } });
  });
}
