// Audit Logs (audit:read; api.md §4.10).
//   GET /admin/audit-logs?action=&entity=&entityId=&actorId=&from=&to=&sort=&page=&limit=   (task 2.1; filters 6.5)
//   GET /admin/audit-logs/entities   record types that have entries (the page's filter)
//   GET /admin/audit-logs/:id        one entry with before / after, session and browser (task 6.5)
//   GET /admin/audit-logs/export.csv the filtered entries as CSV, at most AUDIT_EXPORT_MAX; IPs are personal data, so a
//                                    recent password re-check is needed and the export itself is audited (task 6.5)
// `from`/`to` are India calendar days, inclusive.
import { AUDIT_EXPORT_MAX, auditFilters, auditListQuery, csvCell, type AuditActor, type AuditDetail, type AuditRow, type Permission } from '@artq/shared';
import type { AuditLog, Prisma, PrismaClient } from '@prisma/client';
import type { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { recordAudit } from './router.js';

type Filters = z.output<typeof auditFilters>;
const istDay = (d: string) => new Date(`${d}T00:00:00+05:30`);
const DAY_MS = 86_400_000;

function whereOf(q: Filters): Prisma.AuditLogWhereInput {
  return {
    ...(q.action ? { action: { startsWith: q.action } } : {}),
    ...(q.entity ? { entity: q.entity } : {}),
    ...(q.entityId ? { entityId: q.entityId } : {}),
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: istDay(q.from) } : {}), ...(q.to ? { lt: new Date(istDay(q.to).getTime() + DAY_MS) } : {}) } } : {}),
  };
}

async function actorsOf(prisma: PrismaClient, rows: AuditLog[]): Promise<Map<number, NonNullable<AuditActor>>> {
  const ids = [...new Set(rows.map((r) => r.actorId).filter((x): x is number => x !== null))];
  return new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, name: true } })).map((u) => [u.id, u]));
}
const rowOf = (r: AuditLog, actors: Map<number, NonNullable<AuditActor>>): AuditRow => ({
  id: r.id.toString(), createdAt: r.createdAt.toISOString(), action: r.action, entity: r.entity, entityId: r.entityId,
  actor: r.actorId === null ? null : (actors.get(r.actorId) ?? { id: r.actorId, email: null, name: null }), ip: r.ip,
});

export function registerAuditRoutes(admin: { routes: Router; can: (p: Permission, o?: { stepUp?: boolean }) => RequestHandler }, prisma: PrismaClient): void {
  const r = admin.routes;
  const read = admin.can('audit:read');

  r.get('/audit-logs', read, validate({ query: auditListQuery }), async (req, res) => {
    const q = req.query as unknown as z.output<typeof auditListQuery>;
    const where = whereOf(q);
    const dir = q.sort === 'createdAt' ? 'asc' : 'desc';
    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: [{ createdAt: dir }, { id: dir }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    const actors = await actorsOf(prisma, rows);
    res.set('Cache-Control', 'private, no-store').json({ data: rows.map((x) => rowOf(x, actors)), meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } });
  });

  r.get('/audit-logs/entities', read, async (_req, res) => {
    const rows = await prisma.auditLog.groupBy({ by: ['entity'], orderBy: { entity: 'asc' } });
    res.set('Cache-Control', 'private, no-store').json({ data: rows.map((x) => x.entity) });
  });

  // Before `/:id`, so "export.csv" is never read as an id.
  r.get('/audit-logs/export.csv', admin.can('audit:read', { stepUp: true }), validate({ query: auditFilters }), async (req, res) => {
    const q = req.query as unknown as Filters;
    const rows = await prisma.auditLog.findMany({ where: whereOf(q), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: AUDIT_EXPORT_MAX });
    const actors = await actorsOf(prisma, rows);
    const json = (v: unknown) => (v === null || v === undefined ? '' : JSON.stringify(v));
    const lines = [['id', 'created_at', 'actor_email', 'actor_name', 'action', 'entity', 'entity_id', 'ip', 'before', 'after'].map(csvCell).join(','),
      ...rows.map((x) => { const a = x.actorId === null ? null : actors.get(x.actorId);
        return [x.id.toString(), x.createdAt.toISOString(), a?.email ?? (x.actorId === null ? 'system' : ''), a?.name ?? '', x.action, x.entity, x.entityId ?? '', x.ip ?? '', json(x.before), json(x.after)].map(csvCell).join(','); })];
    await recordAudit(prisma, req, res, { action: 'audit.export', entity: 'audit_log', entityId: 'filtered', after: { rows: rows.length, filters: q, truncated: rows.length === AUDIT_EXPORT_MAX } });
    res.set('Cache-Control', 'private, no-store').type('text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="artq-audit-${new Date().toISOString().slice(0, 10)}.csv"`)
      .set('X-Export-Truncated', rows.length === AUDIT_EXPORT_MAX ? '1' : '0')
      .send(`\uFEFF${lines.join('\r\n')}\r\n`);
  });

  r.get('/audit-logs/:id', read, validate({ params: z.strictObject({ id: z.string().regex(/^\d{1,18}$/, 'An entry number') }) }), async (req, res) => {
    const row = await prisma.auditLog.findUnique({ where: { id: BigInt((req.params as { id: string }).id) } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Audit entry not found');
    const detail: AuditDetail = { ...rowOf(row, await actorsOf(prisma, [row])), sessionId: row.sessionId, userAgent: row.userAgent, before: row.before ?? null, after: row.after ?? null };
    res.set('Cache-Control', 'private, no-store').json(detail);
  });
}
