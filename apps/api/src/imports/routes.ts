// /v1/admin/imports (api.md §4.9, task 2.7) [imports:catalog]. Confirming a file that sets prices also needs
// pricing:write (checked by the service). AT-10: STAFF has neither, so every endpoint answers 403.
import { createImportBody, importListQuery, importRowsQuery, resolveImportRowBody, type Permission, type Role } from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { templateWorkbook } from './catalog-file.js';
import type { ImportActor, ImportService } from './service.js';

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive() });
const rowParam = z.strictObject({ id: z.coerce.number().int().positive(), rowId: z.coerce.number().int().positive() });
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function registerImportRoutes(admin: AdminRoutes, prisma: PrismaClient, imports: ImportService): void {
  const r = admin.routes;
  const perm = admin.can('imports:catalog');
  const who = (req: Request): ImportActor => ({ userId: req.auth!.userId, role: req.auth!.role as Role });
  const id = (req: Request) => (req.params as unknown as { id: number }).id;
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  const audited = async (req: Request, res: Response, action: string, entityId: number, after?: unknown) =>
    recordAudit(prisma, req, res, { action, entity: 'import', entityId, ...(after === undefined ? {} : { after }) });

  const view = async (importId: number) => {
    const imp = await prisma.productImport.findUnique({ where: { id: importId } });
    if (!imp) throw new AppError(404, 'NOT_FOUND', 'Import not found');
    const [byStatus, flagged, products] = await Promise.all([
      prisma.productImportRow.groupBy({ by: ['status'], where: { importId }, _count: { _all: true } }),
      prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM product_import_rows WHERE import_id = ${importId}
        AND (jsonb_array_length(payload->'row'->'product'->'flags') > 0 OR jsonb_array_length(payload->'row'->'variant'->'flags') > 0)`,
      prisma.$queryRaw<{ n: bigint }[]>`SELECT count(DISTINCT product_key) AS n FROM product_import_rows WHERE import_id = ${importId}`,
    ]);
    return {
      ...imp, rows: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
      flaggedRows: Number(flagged[0]!.n), products: Number(products[0]!.n),
    };
  };

  r.get('/imports', perm, validate({ query: importListQuery }), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof importListQuery>;
    const [total, data] = await Promise.all([
      prisma.productImport.count(),
      prisma.productImport.findMany({ orderBy: { id: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    noStore(res).json({ data, meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } });
  });

  r.get('/imports/template.xlsx', perm, async (_req, res) => {
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': XLSX, 'Content-Disposition': 'attachment; filename="artq-catalogue-template.xlsx"' }).send(await templateWorkbook());
  });

  r.post('/imports', perm, validate({ body: createImportBody }), async (req, res) => {
    const body = req.body as z.infer<typeof createImportBody>;
    const imp = await imports.create({ fileMediaId: body.fileMediaId, createMissing: body.createMissing, fileName: body.fileName }, who(req));
    await audited(req, res, 'import.create', imp.id, { fileMediaId: body.fileMediaId, createMissing: body.createMissing });
    noStore(res).status(201).json(await view(imp.id));
  });

  r.get('/imports/:id', perm, validate({ params: idParam }), async (req, res) => { noStore(res).json(await view(id(req))); });

  r.get('/imports/:id/rows', perm, validate({ params: idParam, query: importRowsQuery }), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof importRowsQuery>;
    const where: Prisma.ProductImportRowWhereInput = { importId: id(req), ...(q.status ? { status: q.status } : {}) };
    const flaggedIds = q.flagged ? (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM product_import_rows WHERE import_id = ${id(req)}
      AND (jsonb_array_length(payload->'row'->'product'->'flags') > 0 OR jsonb_array_length(payload->'row'->'variant'->'flags') > 0)`).map((x) => x.id) : null;
    const finalWhere = flaggedIds ? { ...where, id: { in: flaggedIds } } : where;
    const [total, rows] = await Promise.all([
      prisma.productImportRow.count({ where: finalWhere }),
      prisma.productImportRow.findMany({ where: finalWhere, orderBy: { rowNumber: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    noStore(res).json({
      data: rows.map((x) => {
        const row = (x.payload as { row: { product: { name: string; flags: string[] }; variant: { size: string | null; price: number | null; mrp: number | null; stock: number; stockText: string | null; flags: string[] } }; plan: { action: string } });
        return {
          id: x.id, rowNumber: x.rowNumber, sku: x.sku, productKey: x.productKey, status: x.status, plan: row.plan.action,
          productName: row.row.product.name, size: row.row.variant.size, price: row.row.variant.price, mrp: row.row.variant.mrp,
          stock: row.row.variant.stockText ?? row.row.variant.stock, flags: [...row.row.product.flags, ...row.row.variant.flags],
          messages: x.messages, productId: x.productId, variantId: x.variantId,
        };
      }),
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
    });
  });

  r.post('/imports/:id/confirm', perm, validate({ params: idParam }), async (req, res) => {
    await imports.confirm(id(req), who(req));
    await audited(req, res, 'import.confirm_request', id(req));
    noStore(res).json(await view(id(req)));
  });

  r.post('/imports/:id/cancel', perm, validate({ params: idParam }), async (req, res) => {
    await imports.cancel(id(req), who(req));
    await audited(req, res, 'import.cancel_request', id(req));
    noStore(res).json(await view(id(req)));
  });

  r.post('/imports/:id/rows/:rowId/resolve', perm, validate({ params: rowParam, body: resolveImportRowBody }), async (req, res) => {
    const p = req.params as unknown as { id: number; rowId: number };
    await imports.resolve(p.id, p.rowId, (req.body as z.infer<typeof resolveImportRowBody>).action, who(req));
    await audited(req, res, 'import.resolve_request', p.id, { rowId: p.rowId });
    noStore(res).json(await view(p.id));
  });

  r.get('/imports/:id/result.xlsx', perm, validate({ params: idParam }), async (req, res) => {
    const file = await imports.resultFile(id(req));
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="catalog-import-${id(req)}-result.xlsx"` }).send(file);
  });
}
