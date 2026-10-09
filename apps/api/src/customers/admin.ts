// Customers in the admin (task 5.9; api.md §4.8, product.md §7.5) [customers:read; changes customers:write]. List and
// search, detail (orders, addresses, staff note), block / unblock. Contact details are masked for staff without
// customers:write (architecture.md §5.9). Only customer accounts are handled here (staff are under Staff & Permissions);
// blocking ends every session at once (aq_revoke_all_sessions) and is audited with the reason.
import { customerBlockBody, customerListQuery, customerPatchBody, maskContact, type AdminCustomerDetail, type AdminCustomerRow, type Permission } from '@artq/shared';
import { can } from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import type { AuthService } from '../auth/service.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const SOLD = ['PLACED', 'CONFIRMED', 'COMPLETED'] as const;

export class CustomerAdminService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(q: z.output<typeof customerListQuery>, seeContact: boolean) {
    const text = q.q?.trim();
    const digits = text?.replace(/\D/g, '') ?? '';
    const where: Prisma.UserWhereInput = {
      role: 'CUSTOMER', deletedAt: null, ...(q.status ? { status: q.status } : {}),
      ...(text ? { OR: [
        { email: { contains: text, mode: 'insensitive' } }, { name: { contains: text, mode: 'insensitive' } },
        ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
      ] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    const stats = await this.stats(rows.map((r) => r.id));
    const data = rows.map((u) => this.row(u, stats.get(u.id), seeContact));
    return { data, meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
  }

  /** Orders and money spent (placed, not cancelled, after refunds) per customer. */
  private async stats(ids: number[]) {
    if (ids.length === 0) return new Map<number, { orders: number; spent: number }>();
    const rows = await this.prisma.order.groupBy({ by: ['userId'], where: { userId: { in: ids }, status: { in: [...SOLD] } }, _count: true, _sum: { total: true, refundedAmount: true } });
    return new Map(rows.map((r) => [r.userId!, { orders: r._count, spent: (r._sum.total ?? 0) - (r._sum.refundedAmount ?? 0) }]));
  }

  private row(u: Prisma.UserGetPayload<object>, s: { orders: number; spent: number } | undefined, seeContact: boolean): AdminCustomerRow {
    return {
      id: u.id, name: u.name, email: seeContact ? u.email : maskContact(u.email), phone: u.phone ? (seeContact ? u.phone : maskContact(u.phone)) : null, status: u.status,
      emailVerified: u.emailVerifiedAt !== null, orders: s?.orders ?? 0, spent: s?.spent ?? 0, createdAt: u.createdAt.toISOString(), lastLoginAt: iso(u.lastLoginAt),
    };
  }

  async detail(id: number, seeContact: boolean, db: PrismaClient | Prisma.TransactionClient = this.prisma): Promise<AdminCustomerDetail> {
    const u = await db.user.findFirst({ where: { id, role: 'CUSTOMER', deletedAt: null }, include: {
      addresses: { include: { state: { select: { name: true } } }, orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }] },
      orders: { where: { status: { not: 'PENDING_PAYMENT' } }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, orderNumber: true, createdAt: true, total: true, status: true, paymentStatus: true, fulfilmentStatus: true } },
      _count: { select: { wishlist: true } },
    } });
    if (!u) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    const s = (await this.stats([u.id])).get(u.id);
    return {
      ...this.row(u, s, seeContact), contactMasked: !seeContact, marketingOptIn: u.marketingOptIn, adminNotes: u.adminNotes, wishlistCount: u._count.wishlist,
      addresses: u.addresses.map((a) => ({ id: a.id, label: a.label, fullName: a.fullName, phone: seeContact ? a.phone : maskContact(a.phone), isDefault: a.isDefault,
        // Without customers:write the street lines are hidden too: only the place is shown.
        lines: seeContact ? [a.line1, ...(a.line2 ? [a.line2] : []), ...(a.landmark ? [`Near ${a.landmark}`] : []), `${a.city}, ${a.state.name} ${a.pincode}`] : [`${a.city}, ${a.state.name} ${a.pincode}`] })),
      recentOrders: u.orders.map((o) => ({ ...o, createdAt: o.createdAt.toISOString() })),
    };
  }
}

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const TX = { maxWait: 10_000, timeout: 20_000 } as const;

export function registerCustomerRoutes(admin: AdminRoutes, prisma: PrismaClient, auth: Pick<AuthService, 'revokeAll'>, service = new CustomerAdminService(prisma)): void {
  const r = admin.routes;
  const read = admin.can('customers:read');
  const write = admin.can('customers:write');
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  const seeContact = (req: Request) => can(req.auth!.role, 'customers:write');
  const id = (req: Request) => (req.params as unknown as { id: number }).id;
  /** The customer row, locked; 404 for staff accounts and unknown ids. */
  const locked = async (tx: Prisma.TransactionClient, userId: number) => {
    const [u] = await tx.$queryRaw<{ status: string; email_verified: boolean }[]>`
      SELECT status::text, email_verified_at IS NOT NULL AS email_verified FROM users WHERE id = ${userId} AND role = 'CUSTOMER' AND deleted_at IS NULL FOR NO KEY UPDATE`;
    if (!u) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    return u;
  };

  r.get('/customers', read, validate({ query: customerListQuery }), async (req, res) => { noStore(res).json(await service.list(req.query as unknown as z.output<typeof customerListQuery>, seeContact(req))); });
  r.get('/customers/:id', read, validate({ params: idParam }), async (req, res) => { noStore(res).json(await service.detail(id(req), seeContact(req))); });
  r.patch('/customers/:id', write, validate({ params: idParam, body: customerPatchBody }), async (req, res) => {
    const notes = (req.body as z.output<typeof customerPatchBody>).adminNotes;
    await prisma.$transaction(async (tx) => {
      await locked(tx, id(req));
      const before = await tx.user.findUniqueOrThrow({ where: { id: id(req) }, select: { adminNotes: true } });
      await tx.user.update({ where: { id: id(req) }, data: { adminNotes: notes } });
      await recordAudit(tx, req, res, { action: 'customer.notes', entity: 'user', entityId: id(req), before, after: { adminNotes: notes } });
    }, TX);
    noStore(res).json(await service.detail(id(req), true));
  });
  r.post('/customers/:id/block', write, validate({ params: idParam, body: customerBlockBody }), async (req, res) => {
    const reason = (req.body as z.output<typeof customerBlockBody>).reason;
    await auth.revokeAll(id(req), 'BLOCKED', true, async (tx) => {
      const u = await locked(tx, id(req));
      if (u.status === 'BLOCKED') throw new AppError(422, 'INVALID_TRANSITION', 'This customer is already blocked.');
      await recordAudit(tx, req, res, { action: 'customer.block', entity: 'user', entityId: id(req), before: { status: u.status }, after: { status: 'BLOCKED', reason } });
    });
    noStore(res).json(await service.detail(id(req), true));
  });
  r.post('/customers/:id/unblock', write, validate({ params: idParam }), async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const u = await locked(tx, id(req));
      if (u.status !== 'BLOCKED') throw new AppError(422, 'INVALID_TRANSITION', 'This customer is not blocked.');
      const to = u.email_verified ? 'ACTIVE' : 'PENDING_VERIFICATION';
      await tx.user.update({ where: { id: id(req) }, data: { status: to, failedLoginCount: 0, lockedUntil: null } });
      await recordAudit(tx, req, res, { action: 'customer.unblock', entity: 'user', entityId: id(req), before: { status: 'BLOCKED' }, after: { status: to } });
    }, TX);
    noStore(res).json(await service.detail(id(req), true));
  });
}
