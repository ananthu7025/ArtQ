// Staff & Permissions (api.md §4.10, product.md §7 "Staff & Permissions") [staff:manage = SUPER_ADMIN; changes need step-up].
// Adding staff emails a single-use password link to the admin app. Role changes end the person's admin sessions
// (aq_change_role); blocking ends every session (aq_revoke_all_sessions). Removing access = role CUSTOMER.
// Guards: nobody changes their own access here, and the last active SUPER_ADMIN cannot be demoted or blocked.
import type { Prisma, PrismaClient, User } from '@prisma/client';
import type { Request, RequestHandler, Response, Router } from 'express';
import { staffCreateBody, staffListQuery, staffUpdateBody, type Permission } from '@artq/shared';
import { z } from 'zod';
import { normaliseEmail, type AuthService } from '../auth/service.js';
import * as fn from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { recordAudit } from './router.js';

type Tx = Prisma.TransactionClient;
type AdminRoutes = { routes: Router; can: (p: Permission, o?: { stepUp?: boolean }) => RequestHandler };

/** The shared request schemas: the Staff page forms import the same ones (CLAUDE.md "Validation rule"). */
export const staffSchemas = {
  list: staffListQuery, create: staffCreateBody, update: staffUpdateBody,
  id: z.strictObject({ id: z.coerce.number().int().positive() }),
};

const TX = { maxWait: 10_000, timeout: 20_000 } as const;
const notFound = () => new AppError(404, 'NOT_FOUND', 'Staff member not found');
const STAFF_WHERE = { role: { not: 'CUSTOMER' }, deletedAt: null } as const;

export type StaffView = {
  id: number; name: string | null; email: string; role: User['role']; status: User['status']; passwordSet: boolean;
  lastLoginAt: string | null; createdAt: string; activeSessions: number;
};

async function view(db: PrismaClient | Tx, id: number): Promise<StaffView> {
  const u = await db.user.findUniqueOrThrow({ where: { id } });
  const activeSessions = await db.session.count({ where: { userId: id, audience: 'ADMIN', revokedAt: null, idleExpiresAt: { gt: new Date() }, absoluteExpiresAt: { gt: new Date() } } });
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, passwordSet: u.passwordHash !== null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString(), activeSessions,
  };
}

/**
 * Locks the active SUPER_ADMIN rows (ascending id), then the target. Under READ COMMITTED a request that waited sees the
 * outcome of the one before it, so two concurrent demotions can never remove the last SUPER_ADMIN.
 */
async function guard(tx: Tx, actorId: number, targetId: number, removesSuperAdmin: (target: User) => boolean): Promise<User> {
  if (actorId === targetId) throw new AppError(422, 'CANNOT_CHANGE_SELF', 'You cannot change your own access. Ask another Super Admin.');
  const supers = await tx.$queryRaw<{ id: number }[]>`
    SELECT id FROM users WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY id FOR UPDATE`;
  const [locked] = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ${targetId} AND role <> 'CUSTOMER' AND deleted_at IS NULL FOR UPDATE`;
  if (!locked) throw notFound();
  const target = await tx.user.findUniqueOrThrow({ where: { id: targetId } });
  if (removesSuperAdmin(target) && supers.length <= 1 && supers.some((s) => s.id === targetId)) {
    throw new AppError(409, 'LAST_SUPER_ADMIN', 'This is the only active Super Admin. Make someone else Super Admin first.');
  }
  return target;
}

export function registerStaffRoutes(admin: AdminRoutes, prisma: PrismaClient, auth: AuthService): void {
  const r = admin.routes;
  const manage = admin.can('staff:manage');
  const id = (req: Request) => (req.params as unknown as { id: number }).id;
  const audit = (tx: Tx, req: Request, res: Response, action: string, entityId: number, before?: unknown, after?: unknown) =>
    recordAudit(tx, req, res, { action, entity: 'user', entityId, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
  const send = async (res: Response, userId: number, status = 200) => { res.set('Cache-Control', 'private, no-store').status(status).json(await view(prisma, userId)); };

  // Reading the list needs the permission but not a fresh password check.
  r.get('/staff', admin.can('staff:manage', { stepUp: false }), validate({ query: staffSchemas.list }), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof staffSchemas.list>;
    const where: Prisma.UserWhereInput = {
      ...STAFF_WHERE, ...(q.role ? { role: q.role } : {}), ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ email: { contains: q.q, mode: 'insensitive' } }, { name: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, orderBy: [{ role: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit, select: { id: true } }),
    ]);
    res.set('Cache-Control', 'private, no-store').json({
      data: await Promise.all(rows.map((u) => view(prisma, u.id))),
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
    });
  });

  // Add staff: a new account, or an existing customer account promoted (same email = same person, one login).
  r.post('/staff', manage, validate({ body: staffSchemas.create }), async (req, res) => {
    const body = req.body as z.infer<typeof staffSchemas.create>;
    const email = normaliseEmail(body.email);
    const userId = await prisma.$transaction(async (tx) => {
      await auth.lockTarget(tx, email);
      const existing = await tx.user.findFirst({ where: { email, deletedAt: null } });
      if (existing && existing.role !== 'CUSTOMER') throw new AppError(409, 'STAFF_EXISTS', 'This person is already on the staff list');
      if (existing && existing.status === 'BLOCKED') throw new AppError(409, 'ACCOUNT_BLOCKED', 'This email belongs to a blocked customer account. Unblock it under Customers first.');
      let user: User;
      if (existing) {
        await fn.changeRole(tx, existing.id, body.role);
        user = await tx.user.update({ where: { id: existing.id }, data: { name: existing.name ?? body.name, status: 'ACTIVE' } });
      } else {
        user = await tx.user.create({ data: { email, name: body.name, role: body.role, status: 'ACTIVE' } });
      }
      const invited = await auth.sendStaffInvite(tx, user);
      await audit(tx, req, res, 'staff.create', user.id, undefined, { email, role: body.role, promotedCustomer: Boolean(existing), invited });
      return user.id;
    }, TX);
    await send(res, userId, 201);
  });

  r.patch('/staff/:id', manage, validate({ params: staffSchemas.id, body: staffSchemas.update }), async (req, res) => {
    const body = req.body as z.infer<typeof staffSchemas.update>;
    const targetId = id(req);
    const current = await prisma.user.findFirst({ where: { id: targetId, ...STAFF_WHERE } });
    if (!current) throw notFound();
    if (body.role !== undefined && body.role !== current.role) {
      const role = body.role;
      await auth.changeRole(targetId, role, async (tx) => {
        const t = await guard(tx, req.auth!.userId, targetId, (u) => u.role === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN');
        if (body.name !== undefined) await tx.user.update({ where: { id: targetId }, data: { name: body.name } });
        await audit(tx, req, res, role === 'CUSTOMER' ? 'staff.remove' : 'staff.role_change', targetId, { role: t.role, name: t.name }, { role, ...(body.name ? { name: body.name } : {}) });
      });
    } else {
      await prisma.$transaction(async (tx) => {
        const [t] = await tx.$queryRaw<{ name: string | null }[]>`SELECT name FROM users WHERE id = ${targetId} AND role <> 'CUSTOMER' AND deleted_at IS NULL FOR UPDATE`;
        if (!t) throw notFound();
        await tx.user.update({ where: { id: targetId }, data: { name: body.name ?? t.name } });
        await audit(tx, req, res, 'staff.rename', targetId, { name: t.name }, { name: body.name ?? t.name });
      }, TX);
    }
    if (body.role === 'CUSTOMER') { res.status(204).end(); return; }   // no longer on the staff list
    await send(res, targetId);
  });

  r.post('/staff/:id/block', manage, validate({ params: staffSchemas.id }), async (req, res) => {
    const targetId = id(req);
    await auth.revokeAll(targetId, 'BLOCKED', true, async (tx) => {
      const t = await guard(tx, req.auth!.userId, targetId, (u) => u.role === 'SUPER_ADMIN');
      if (t.status === 'BLOCKED') throw new AppError(422, 'INVALID_TRANSITION', 'This person is already blocked');
      await audit(tx, req, res, 'staff.block', targetId, { status: t.status }, { status: 'BLOCKED' });
    });
    await send(res, targetId);
  });

  r.post('/staff/:id/unblock', manage, validate({ params: staffSchemas.id }), async (req, res) => {
    const targetId = id(req);
    await prisma.$transaction(async (tx) => {
      const t = await guard(tx, req.auth!.userId, targetId, () => false);
      if (t.status !== 'BLOCKED') throw new AppError(422, 'INVALID_TRANSITION', 'This person is not blocked');
      await tx.user.update({ where: { id: targetId }, data: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null } });
      await audit(tx, req, res, 'staff.unblock', targetId, { status: 'BLOCKED' }, { status: 'ACTIVE' });
    }, TX);
    await send(res, targetId);
  });

  // "Sign out everywhere" for someone else (your own: POST /admin/auth/logout-all).
  r.post('/staff/:id/revoke-sessions', manage, validate({ params: staffSchemas.id }), async (req, res) => {
    const targetId = id(req);
    await auth.revokeAll(targetId, 'ADMIN_REVOKED', false, async (tx) => {
      await guard(tx, req.auth!.userId, targetId, () => false);
      await audit(tx, req, res, 'staff.revoke_sessions', targetId);
    });
    await send(res, targetId);
  });

  // A fresh password link (first invite lost, or a forgotten password). Limited per account per hour.
  r.post('/staff/:id/send-password-link', manage, validate({ params: staffSchemas.id }), async (req, res) => {
    const targetId = id(req);
    await prisma.$transaction(async (tx) => {
      const t = await guard(tx, req.auth!.userId, targetId, () => false);
      if (t.status !== 'ACTIVE') throw new AppError(422, 'INVALID_TRANSITION', 'Unblock this person before sending a password link');
      if (!(await auth.sendStaffInvite(tx, t))) throw new AppError(429, 'RATE_LIMITED', 'Too many password links for this account in the last hour. Try again later.');
      await audit(tx, req, res, 'staff.password_link', targetId);
    }, TX);
    await send(res, targetId);
  });
}
