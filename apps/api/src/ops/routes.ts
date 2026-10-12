// Payment Exceptions [payments:exceptions] and Jobs & Webhooks [jobs:read; retries jobs:retry] (task 5.8; api.md §4.10).
//   GET  /admin/payment-exceptions?status=&open=1&type=&orderId=   · POST /admin/payment-exceptions/:id/resolve · /dismiss
//   POST /admin/payments/reconcile {orderId?}
//   GET  /admin/ops/summary · /admin/ops/webhooks?status= · /admin/ops/outbox-deliveries?status=&consumer= · /admin/ops/jobs/failed
//   POST /admin/ops/webhooks/:id/retry · /admin/ops/outbox-deliveries/:id/retry · /admin/ops/jobs/:queue/:id/retry
import { exceptionDismissBody, exceptionListQuery, exceptionResolveBody, opsOutboxQuery, opsWebhookQuery, reconcileBody, type Permission } from '@artq/shared';
import type { Request, RequestHandler, Response, Router } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { validate } from '../middleware/validate.js';
import type { OpsService } from './service.js';

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive().max(9_007_199_254_740_991) });
const jobParam = z.strictObject({ queue: z.string().regex(/^[a-z0-9._-]{1,60}$/), id: z.string().regex(/^[A-Za-z0-9:_.-]{1,200}$/) });

export function registerOpsRoutes(admin: AdminRoutes, service: OpsService, log: Logger): void {
  const r = admin.routes;
  const exc = admin.can('payments:exceptions');
  const read = admin.can('jobs:read');
  const retry = admin.can('jobs:retry');
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  const id = (req: Request) => (req.params as unknown as { id: number }).id;

  r.get('/payment-exceptions', exc, validate({ query: exceptionListQuery }), async (req, res) => { noStore(res).json(await service.exceptions(req.query as unknown as z.output<typeof exceptionListQuery>)); });
  r.post('/payment-exceptions/:id/resolve', exc, validate({ params: idParam, body: exceptionResolveBody }), async (req, res) => {
    const text = (req.body as z.output<typeof exceptionResolveBody>).resolution;
    noStore(res).json(await service.close(id(req), 'RESOLVED', text, req.auth!.userId, (tx, before) => recordAudit(tx, req, res, { action: 'payment_exception.resolve', entity: 'payment_exception', entityId: id(req), before, after: { status: 'RESOLVED', resolution: text } })));
  });
  r.post('/payment-exceptions/:id/dismiss', exc, validate({ params: idParam, body: exceptionDismissBody }), async (req, res) => {
    const text = (req.body as z.output<typeof exceptionDismissBody>).note;
    noStore(res).json(await service.close(id(req), 'DISMISSED', text, req.auth!.userId, (tx, before) => recordAudit(tx, req, res, { action: 'payment_exception.dismiss', entity: 'payment_exception', entityId: id(req), before, after: { status: 'DISMISSED', resolution: text } })));
  });
  r.post('/payments/reconcile', exc, validate({ body: reconcileBody }), async (req, res) => {
    const b = req.body as z.output<typeof reconcileBody>;
    const out = await service.reconcile(b.orderId, log);
    await recordAudit(service.prisma, req, res, { action: 'payments.reconcile', entity: 'order', entityId: b.orderId ?? 'all', after: out });
    noStore(res).json(out);
  });

  r.get('/ops/summary', read, async (_req, res) => { noStore(res).json(await service.summary()); });
  r.get('/ops/webhooks', read, validate({ query: opsWebhookQuery }), async (req, res) => { noStore(res).json(await service.webhooks(req.query as unknown as z.output<typeof opsWebhookQuery>)); });
  r.get('/ops/outbox-deliveries', read, validate({ query: opsOutboxQuery }), async (req, res) => { noStore(res).json(await service.outbox(req.query as unknown as z.output<typeof opsOutboxQuery>)); });
  r.get('/ops/jobs/failed', read, async (_req, res) => { noStore(res).json({ data: await service.failedJobs() }); });
  r.post('/ops/webhooks/:id/retry', retry, validate({ params: idParam }), async (req, res) => {
    await service.retryWebhook(id(req), (tx) => recordAudit(tx, req, res, { action: 'webhook.retry', entity: 'webhook_event', entityId: id(req) }));
    noStore(res).json({ ok: true });
  });
  r.post('/ops/outbox-deliveries/:id/retry', retry, validate({ params: idParam }), async (req, res) => {
    await service.retryOutbox(id(req), (tx) => recordAudit(tx, req, res, { action: 'outbox.retry', entity: 'outbox_delivery', entityId: id(req) }));
    noStore(res).json({ ok: true });
  });
  r.post('/ops/jobs/:queue/:id/retry', retry, validate({ params: jobParam }), async (req, res) => {
    const p = req.params as { queue: string; id: string };
    await service.retryJob(p.queue, p.id);
    await recordAudit(service.prisma, req, res, { action: 'job.retry', entity: 'job', entityId: `${p.queue}:${p.id}` });
    noStore(res).json({ ok: true });
  });
}
