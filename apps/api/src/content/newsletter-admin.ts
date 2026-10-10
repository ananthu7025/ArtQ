// Newsletter in the admin (task 6.3; api.md §4.10 "CMS") [content:write]. The subscriber list with counts, an
// unsubscribe on request (DPDP Act: on request), and the CSV export of current subscribers (with each one's
// unsubscribe link, for a campaign tool) behind a recent password re-check, audited.
import { csvCell, newsletterListQuery, type NewsletterRow, type NewsletterSummary, type Permission } from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';

type AdminRoutes = { routes: Router; can: (p: Permission, o?: { stepUp?: boolean }) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive().max(2_147_483_647) });

export function registerNewsletterRoutes(admin: AdminRoutes, prisma: PrismaClient, webUrl: string): void {
  const r = admin.routes;
  const write = admin.can('content:write');
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  const view = (s: { id: number; email: string; status: 'SUBSCRIBED' | 'UNSUBSCRIBED'; source: string; createdAt: Date; unsubscribedAt: Date | null }): NewsletterRow =>
    ({ id: s.id, email: s.email, status: s.status, source: s.source, createdAt: s.createdAt.toISOString(), unsubscribedAt: s.unsubscribedAt?.toISOString() ?? null });

  r.get('/newsletter', write, validate({ query: newsletterListQuery }), async (req, res) => {
    const q = req.query as unknown as z.output<typeof newsletterListQuery>;
    const where: Prisma.NewsletterSubscriberWhereInput = { ...(q.status ? { status: q.status } : {}), ...(q.q ? { email: { contains: q.q, mode: 'insensitive' } } : {}) };
    const [total, rows, counts] = await Promise.all([
      prisma.newsletterSubscriber.count({ where }),
      prisma.newsletterSubscriber.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      prisma.newsletterSubscriber.groupBy({ by: ['status'], _count: true }),
    ]);
    const summary: NewsletterSummary = { subscribed: counts.find((c) => c.status === 'SUBSCRIBED')?._count ?? 0, unsubscribed: counts.find((c) => c.status === 'UNSUBSCRIBED')?._count ?? 0 };
    noStore(res).json({ data: rows.map(view), summary, meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } });
  });

  r.post('/newsletter/:id/unsubscribe', write, validate({ params: idParam }), async (req: Request, res: Response) => {
    const id = (req.params as unknown as { id: number }).id;
    const row = await prisma.$transaction(async (tx) => {
      const n = await tx.newsletterSubscriber.updateMany({ where: { id, status: 'SUBSCRIBED' }, data: { status: 'UNSUBSCRIBED', unsubscribedAt: new Date() } });
      if (n.count !== 1) {
        if (!(await tx.newsletterSubscriber.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(404, 'NOT_FOUND', 'Subscriber not found');
        throw new AppError(422, 'INVALID_TRANSITION', 'This address is already unsubscribed.');
      }
      await recordAudit(tx, req, res, { action: 'newsletter.unsubscribe', entity: 'newsletter_subscriber', entityId: id, after: { status: 'UNSUBSCRIBED' } });
      return tx.newsletterSubscriber.findUniqueOrThrow({ where: { id } });
    });
    noStore(res).json(view(row));
  });

  /** Current subscribers as CSV (personal data: recent password re-check, audited). */
  r.get('/newsletter/export.csv', admin.can('content:write', { stepUp: true }), async (req, res) => {
    const rows = await prisma.newsletterSubscriber.findMany({ where: { status: 'SUBSCRIBED' }, orderBy: { createdAt: 'asc' } });
    const base = webUrl.replace(/\/$/, '');
    const lines = [['email', 'source', 'subscribed_at', 'unsubscribe_url'].map(csvCell).join(','),
      ...rows.map((s) => [s.email, s.source, s.createdAt.toISOString(), `${base}/newsletter/unsubscribe?token=${s.unsubscribeToken}`].map(csvCell).join(','))];
    await recordAudit(prisma, req, res, { action: 'newsletter.export', entity: 'newsletter_subscriber', entityId: 'all', after: { rows: rows.length } });
    noStore(res).type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="artq-newsletter-${new Date().toISOString().slice(0, 10)}.csv"`).send(`\uFEFF${lines.join('\r\n')}\r\n`);
  });
}
