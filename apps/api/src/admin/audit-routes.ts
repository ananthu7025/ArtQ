// GET /v1/admin/audit-logs (Audit Logs module, audit:read): server-side paginated per api.md §1 conventions.
import type { Prisma, PrismaClient } from '@prisma/client';
import type { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

export const auditQuery = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().trim().min(1).max(60).optional(),
  entity: z.string().trim().min(1).max(40).optional(),
  actorId: z.coerce.number().int().positive().optional(),
  sort: z.enum(['createdAt', '-createdAt']).default('-createdAt'),
});

export function registerAuditRoutes(admin: { routes: Router; can: (p: 'audit:read') => RequestHandler }, prisma: PrismaClient): void {
  admin.routes.get('/audit-logs', admin.can('audit:read'), validate({ query: auditQuery }), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof auditQuery>;
    const where: Prisma.AuditLogWhereInput = {
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: [{ createdAt: q.sort === 'createdAt' ? 'asc' : 'desc' }, { id: q.sort === 'createdAt' ? 'asc' : 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is number => x !== null))];
    const actors = new Map((await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true, name: true } })).map((u) => [u.id, u]));
    res.set('Cache-Control', 'private, no-store').json({
      data: rows.map((r) => ({
        id: r.id.toString(), createdAt: r.createdAt.toISOString(), action: r.action, entity: r.entity, entityId: r.entityId,
        actor: r.actorId === null ? null : (actors.get(r.actorId) ?? { id: r.actorId, email: null, name: null }), ip: r.ip,
      })),
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
    });
  });
}
