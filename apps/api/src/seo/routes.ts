// SEO endpoints (task 6.4).
//   Public (cacheable 60 s): GET /seo/resolve?path= · GET /seo/sitemap-entries
//   Admin [content:write]: GET/POST /admin/seo/redirects · PUT/DELETE /admin/seo/redirects/:id
//                          GET/POST /admin/seo/overrides · PUT/DELETE /admin/seo/overrides/:id
// A redirect may not start where another one ends up being pointed to directly (one hop, never a chain made on purpose);
// every change is audited.
import {
  normalizeSeoPath, redirectBody, seoListQuery, seoOverrideBody, seoResolveQuery,
  type Permission, type RedirectRow, type SeoOverrideRow,
} from '@artq/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import type { MediaUrl } from '../storefront/home.js';
import { resolveSeo, sitemapEntries } from './service.js';

export function seoRouter(d: { prisma: PrismaClient; mediaUrl: MediaUrl }): Router {
  const r = Router();
  r.get('/seo/resolve', validate({ query: seoResolveQuery }), async (req, res) => {
    res.json(await resolveSeo(d.prisma, (req.query as unknown as z.output<typeof seoResolveQuery>).path));
  });
  r.get('/seo/sitemap-entries', async (_req, res) => { res.json(await sitemapEntries(d.prisma, d.mediaUrl)); });
  return r;
}

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const fieldError = (path: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path, message }]);
const taken = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const redirectRow = (x: { id: number; fromPath: string; toPath: string; statusCode: number }): RedirectRow => ({ id: x.id, fromPath: x.fromPath, toPath: x.toPath, statusCode: x.statusCode === 302 ? 302 : 301 });
const overrideRow = (x: SeoOverrideRow): SeoOverrideRow => ({ id: x.id, path: x.path, metaTitle: x.metaTitle, metaDescription: x.metaDescription, canonical: x.canonical, noindex: x.noindex });

export function registerSeoAdminRoutes(admin: AdminRoutes, prisma: PrismaClient): void {
  const r = admin.routes;
  const write = admin.can('content:write');
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  const id = (req: Request) => (req.params as unknown as { id: number }).id;
  const page = (total: number, q: { page: number; limit: number }) => ({ page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) });

  // ── Redirects ──
  r.get('/seo/redirects', write, validate({ query: seoListQuery }), async (req, res) => {
    const q = req.query as unknown as z.output<typeof seoListQuery>;
    const where: Prisma.RedirectWhereInput = q.q ? { OR: [{ fromPath: { contains: q.q, mode: 'insensitive' } }, { toPath: { contains: q.q, mode: 'insensitive' } }] } : {};
    const [total, rows] = await Promise.all([prisma.redirect.count({ where }), prisma.redirect.findMany({ where, orderBy: { fromPath: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit })]);
    noStore(res).json({ data: rows.map(redirectRow), meta: page(total, q) });
  });

  const saveRedirect = async (req: Request, res: Response, existing: number | null) => {
    const b = req.body as z.output<typeof redirectBody>;
    const row = await prisma.$transaction(async (tx) => {
      const before = existing === null ? null : await tx.redirect.findUnique({ where: { id: existing } });
      if (existing !== null && !before) throw new AppError(404, 'NOT_FOUND', 'Redirect not found');
      const onward = await tx.redirect.findUnique({ where: { fromPath: normalizeSeoPath(b.toPath) } });
      if (onward && onward.id !== existing) throw fieldError('toPath', `That address already redirects to ${onward.toPath}. Point straight there.`);
      const data = { fromPath: b.fromPath, toPath: b.toPath, statusCode: b.statusCode };
      const saved = await (existing === null ? tx.redirect.create({ data }) : tx.redirect.update({ where: { id: existing }, data })).catch((e: unknown) => {
        throw taken(e) ? fieldError('fromPath', 'This address already has a redirect') : e;
      });
      await recordAudit(tx, req, res, { action: existing === null ? 'seo.redirect.create' : 'seo.redirect.update', entity: 'redirect', entityId: saved.id, ...(before ? { before: redirectRow(before) } : {}), after: redirectRow(saved) });
      return saved;
    });
    noStore(res).status(existing === null ? 201 : 200).json(redirectRow(row));
  };
  r.post('/seo/redirects', write, validate({ body: redirectBody }), (req, res) => saveRedirect(req, res, null));
  r.put('/seo/redirects/:id', write, validate({ params: idParam, body: redirectBody }), (req, res) => saveRedirect(req, res, id(req)));
  r.delete('/seo/redirects/:id', write, validate({ params: idParam }), async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const before = await tx.redirect.findUnique({ where: { id: id(req) } });
      if (!before) throw new AppError(404, 'NOT_FOUND', 'Redirect not found');
      await tx.redirect.delete({ where: { id: before.id } });
      await recordAudit(tx, req, res, { action: 'seo.redirect.delete', entity: 'redirect', entityId: before.id, before: redirectRow(before) });
    });
    noStore(res).status(204).end();
  });

  // ── Overrides ──
  r.get('/seo/overrides', write, validate({ query: seoListQuery }), async (req, res) => {
    const q = req.query as unknown as z.output<typeof seoListQuery>;
    const where: Prisma.SeoOverrideWhereInput = q.q ? { path: { contains: q.q, mode: 'insensitive' } } : {};
    const [total, rows] = await Promise.all([prisma.seoOverride.count({ where }), prisma.seoOverride.findMany({ where, orderBy: { path: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit })]);
    noStore(res).json({ data: rows.map(overrideRow), meta: page(total, q) });
  });

  const saveOverride = async (req: Request, res: Response, existing: number | null) => {
    const b = req.body as z.output<typeof seoOverrideBody>;
    const row = await prisma.$transaction(async (tx) => {
      const before = existing === null ? null : await tx.seoOverride.findUnique({ where: { id: existing } });
      if (existing !== null && !before) throw new AppError(404, 'NOT_FOUND', 'Override not found');
      const data = { path: b.path, metaTitle: b.metaTitle, metaDescription: b.metaDescription, canonical: b.canonical, noindex: b.noindex };
      const saved = await (existing === null ? tx.seoOverride.create({ data }) : tx.seoOverride.update({ where: { id: existing }, data })).catch((e: unknown) => {
        throw taken(e) ? fieldError('path', 'This address already has an override; edit that one') : e;
      });
      await recordAudit(tx, req, res, { action: existing === null ? 'seo.override.create' : 'seo.override.update', entity: 'seo_override', entityId: saved.id, ...(before ? { before: overrideRow(before) } : {}), after: overrideRow(saved) });
      return saved;
    });
    noStore(res).status(existing === null ? 201 : 200).json(overrideRow(row));
  };
  r.post('/seo/overrides', write, validate({ body: seoOverrideBody }), (req, res) => saveOverride(req, res, null));
  r.put('/seo/overrides/:id', write, validate({ params: idParam, body: seoOverrideBody }), (req, res) => saveOverride(req, res, id(req)));
  r.delete('/seo/overrides/:id', write, validate({ params: idParam }), async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const before = await tx.seoOverride.findUnique({ where: { id: id(req) } });
      if (!before) throw new AppError(404, 'NOT_FOUND', 'Override not found');
      await tx.seoOverride.delete({ where: { id: before.id } });
      await recordAudit(tx, req, res, { action: 'seo.override.delete', entity: 'seo_override', entityId: before.id, before: overrideRow(before) });
    });
    noStore(res).status(204).end();
  });
}
