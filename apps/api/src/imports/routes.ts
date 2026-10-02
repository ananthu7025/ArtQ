// /v1/admin/imports (api.md §4.9, tasks 2.7/2.8). Catalogue imports need imports:catalog (confirming a file that sets
// prices also needs pricing:write); inventory count imports need inventory:adjust. Every endpoint checks the import's
// own kind, so STAFF (inventory only) can never read or act on a catalogue import (AT-10).
import { can, createImportBody, importListQuery, importRowsQuery, resolveImportRowBody, type Permission, type Role } from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { countSheet } from '../inventory/routes.js';
import { templateWorkbook } from './catalog-file.js';
import { importPermission, type ImportActor, type ImportService } from './service.js';

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive() });
const rowParam = z.strictObject({ id: z.coerce.number().int().positive(), rowId: z.coerce.number().int().positive() });
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function registerImportRoutes(admin: AdminRoutes, prisma: PrismaClient, imports: ImportService): void {
  const r = admin.routes;
  const kinds = (role: string) => (['CATALOG', 'INVENTORY'] as const).filter((k) => can(role as Role, importPermission(k)));
  /** Either import permission (the import's own kind is checked per request). */
  const perm: RequestHandler = (req, _res, next) => next(req.auth && kinds(req.auth.role).length ? undefined : new AppError(403, 'FORBIDDEN', 'You do not have permission to do this', { permission: 'imports:catalog' }));
  /** The import exists and the caller may use its kind. */
  const own = async (req: Request) => {
    const imp = await prisma.productImport.findUnique({ where: { id: (req.params as unknown as { id: number }).id }, select: { kind: true } });
    if (!imp) throw new AppError(404, 'NOT_FOUND', 'Import not found');
    if (!kinds(req.auth!.role).includes(imp.kind)) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do this', { permission: importPermission(imp.kind) });
  };
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
      prisma.productImport.count({ where: { kind: { in: kinds(req.auth!.role) } } }),
      prisma.productImport.findMany({ where: { kind: { in: kinds(req.auth!.role) } }, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    noStore(res).json({ data, meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } });
  });

  r.get('/imports/template.xlsx', perm, validate({ query: z.strictObject({ kind: z.enum(['CATALOG', 'INVENTORY']).default('CATALOG') }) }), async (req, res) => {
    const kind = (req.query as unknown as { kind: 'CATALOG' | 'INVENTORY' }).kind;
    if (!kinds(req.auth!.role).includes(kind)) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do this', { permission: importPermission(kind) });
    const [file, name] = kind === 'CATALOG' ? [await templateWorkbook(), 'artq-catalogue-template.xlsx'] : [await countSheet([]), 'artq-stock-count-template.xlsx'];
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${name}"` }).send(file);
  });

  r.post('/imports', perm, validate({ body: createImportBody }), async (req, res) => {
    const body = req.body as z.infer<typeof createImportBody>;
    const imp = await imports.create({ kind: body.kind, fileMediaId: body.fileMediaId, createMissing: body.createMissing, fileName: body.fileName }, who(req));
    await audited(req, res, 'import.create', imp.id, { fileMediaId: body.fileMediaId, createMissing: body.createMissing });
    noStore(res).status(201).json(await view(imp.id));
  });

  r.get('/imports/:id', perm, validate({ params: idParam }), async (req, res) => { await own(req); noStore(res).json(await view(id(req))); });

  r.get('/imports/:id/rows', perm, validate({ params: idParam, query: importRowsQuery }), async (req, res) => {
    await own(req);
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
        const base = { id: x.id, rowNumber: x.rowNumber, sku: x.sku, status: x.status, messages: x.messages, productId: x.productId, variantId: x.variantId };
        const payload = x.payload as Record<string, unknown>;
        if (!('row' in payload)) {
          // Inventory count row
          const c = payload as { kind: string | null; quantity: number | null; note: string | null; systemOnHand: number | null };
          return { ...base, kind: c.kind, quantity: c.quantity, note: c.note, systemOnHand: c.systemOnHand };
        }
        const row = payload as { row: { product: { name: string; flags: string[] }; variant: { size: string | null; price: number | null; mrp: number | null; stock: number; stockText: string | null; flags: string[] } }; plan: { action: string } };
        return {
          ...base, productKey: x.productKey, plan: row.plan.action, productName: row.row.product.name, size: row.row.variant.size, price: row.row.variant.price, mrp: row.row.variant.mrp,
          stock: row.row.variant.stockText ?? row.row.variant.stock, flags: [...row.row.product.flags, ...row.row.variant.flags],
        };
      }),
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
    });
  });

  r.post('/imports/:id/confirm', perm, validate({ params: idParam }), async (req, res) => {
    await own(req);
    await imports.confirm(id(req), who(req));
    await audited(req, res, 'import.confirm_request', id(req));
    noStore(res).json(await view(id(req)));
  });

  r.post('/imports/:id/cancel', perm, validate({ params: idParam }), async (req, res) => {
    await own(req);
    await imports.cancel(id(req), who(req));
    await audited(req, res, 'import.cancel_request', id(req));
    noStore(res).json(await view(id(req)));
  });

  r.post('/imports/:id/rows/:rowId/resolve', perm, validate({ params: rowParam, body: resolveImportRowBody }), async (req, res) => {
    await own(req);
    const p = req.params as unknown as { id: number; rowId: number };
    await imports.resolve(p.id, p.rowId, (req.body as z.infer<typeof resolveImportRowBody>).action, who(req));
    await audited(req, res, 'import.resolve_request', p.id, { rowId: p.rowId });
    noStore(res).json(await view(p.id));
  });

  r.get('/imports/:id/result.xlsx', perm, validate({ params: idParam }), async (req, res) => {
    await own(req);
    const file = await imports.resultFile(id(req));
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="catalog-import-${id(req)}-result.xlsx"` }).send(file);
  });
}
