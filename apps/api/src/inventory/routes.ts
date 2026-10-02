// /v1/admin/inventory (api.md §4.5, task 2.8) [inventory:read / inventory:adjust]. On-hand only: every change goes through
// aq_adjust_on_hand (variants ascending, OVERSOLD exception when a count is below what is reserved, back-in-stock event,
// aggregates refreshed). `reserved` is never written here and the schemas carry no price fields (AT-10).
import { adjustmentsBody, inventoryListQuery, movementsQuery, type Permission } from '@artq/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { parseDbError } from '../db/errors.js';
import * as fn from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import { storeReadiness } from '../imports/service.js';
import { validate } from '../middleware/validate.js';

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
const variantParam = z.strictObject({ variantId: z.coerce.number().int().positive() });
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Row = { variant_id: number; sku: string; label: string; product_id: number; product_name: string; product_status: string; on_hand: number; reserved: number; low_stock_threshold: number; inventory_counted_at: Date | null; is_active: boolean; total: bigint };

export function registerInventoryRoutes(admin: AdminRoutes, prisma: PrismaClient): void {
  const r = admin.routes;
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');

  r.get('/inventory', admin.can('inventory:read'), validate({ query: inventoryListQuery }), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof inventoryListQuery>;
    const where: Prisma.Sql[] = [Prisma.sql`v.deleted_at IS NULL AND p.deleted_at IS NULL`];
    if (q.q) where.push(Prisma.sql`(v.sku ILIKE ${like(q.q)} OR p.name ILIKE ${like(q.q)} OR v.label ILIKE ${like(q.q)})`);
    if (q.stock === 'low') where.push(Prisma.sql`v.on_hand - v.reserved > 0 AND v.on_hand - v.reserved <= v.low_stock_threshold`);
    if (q.stock === 'out') where.push(Prisma.sql`v.on_hand - v.reserved <= 0`);
    if (q.stock === 'oversold') where.push(Prisma.sql`v.on_hand < v.reserved`);
    if (q.stock === 'uncounted') where.push(Prisma.sql`v.inventory_counted_at IS NULL`);
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT v.id AS variant_id, v.sku, v.label, p.id AS product_id, p.name AS product_name, p.status::text AS product_status, v.on_hand, v.reserved,
             v.low_stock_threshold, v.inventory_counted_at, v.is_active, count(*) OVER () AS total
        FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE ${Prisma.join(where, ' AND ')}
       ORDER BY (v.on_hand < v.reserved) DESC, lower(p.name), v.sort_order, v.id
       LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`;
    const total = rows[0] ? Number(rows[0].total) : Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM product_variants v JOIN products p ON p.id = v.product_id WHERE ${Prisma.join(where, ' AND ')}`)[0]!.n);
    noStore(res).json({
      data: rows.map((x) => ({
        variantId: x.variant_id, sku: x.sku, label: x.label, product: { id: x.product_id, name: x.product_name, status: x.product_status },
        onHand: x.on_hand, reserved: x.reserved, available: x.on_hand - x.reserved, lowStockThreshold: x.low_stock_threshold,
        countedAt: x.inventory_counted_at?.toISOString() ?? null, isActive: x.is_active,
      })),
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
    });
  });

  /** Recount / adjustment / damage write-off for one or more variants, in one transaction. */
  r.post('/inventory/adjustments', admin.can('inventory:adjust'), validate({ body: adjustmentsBody }), async (req: Request, res: Response) => {
    const { rows } = req.body as z.infer<typeof adjustmentsBody>;
    const ids = rows.map((x) => x.variantId);
    const result = await prisma.$transaction(async (tx) => {
      const before = await tx.productVariant.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, onHand: true, reserved: true } });
      const missing = ids.filter((id) => !before.some((b) => b.id === id));
      if (missing.length) throw new AppError(404, 'NOT_FOUND', 'Some variants do not exist', { variantIds: missing });
      try {
        await fn.adjustOnHand(tx, { rows: rows.map((x) => ({ variantId: x.variantId, kind: x.kind, quantity: x.quantity, ...(x.note ? { note: x.note } : {}) })), actorId: req.auth!.userId });
      } catch (e) {
        const d = parseDbError(e);
        if (d?.code === 'INVALID_ADJUSTMENT') throw new AppError(422, 'INVALID_ADJUSTMENT', 'This would leave less than 0 units on hand', { variantId: Number(d.detail) });
        throw e;
      }
      const after = await tx.productVariant.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, onHand: true, reserved: true, inventoryCountedAt: true, productId: true } });
      await storeReadiness(tx, [...new Set(after.map((a) => a.productId))]);   // a recount can clear "stock uncounted"
      await recordAudit(tx, req, res, {
        action: 'inventory.adjust', entity: 'variant',
        before: before.map((b) => ({ variantId: b.id, onHand: b.onHand })), after: rows.map((x) => ({ ...x, onHand: after.find((a) => a.id === x.variantId)!.onHand })),
      });
      return after;
    }, { maxWait: 10_000, timeout: 30_000 });
    noStore(res).json({
      data: result.map((a) => ({ variantId: a.id, sku: a.sku, onHand: a.onHand, reserved: a.reserved, available: a.onHand - a.reserved, countedAt: a.inventoryCountedAt?.toISOString() ?? null })),
      oversold: result.filter((a) => a.onHand < a.reserved).map((a) => a.id),
    });
  });

  /** The ledger of one variant: every movement, newest first (reservations, orders, returns, imports, counts). */
  r.get('/inventory/:variantId/movements', admin.can('inventory:read'), validate({ params: variantParam, query: movementsQuery }), async (req, res) => {
    const { variantId } = req.params as unknown as { variantId: number };
    const q = req.query as unknown as z.infer<typeof movementsQuery>;
    const v = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { id: true, sku: true, label: true, onHand: true, reserved: true, product: { select: { id: true, name: true } } } });
    if (!v) throw new AppError(404, 'NOT_FOUND', 'Variant not found');
    const [total, moves] = await Promise.all([
      prisma.inventoryMovement.count({ where: { variantId } }),
      prisma.inventoryMovement.findMany({ where: { variantId }, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, include: { order: { select: { orderNumber: true } } } }),
    ]);
    const actors = new Map((await prisma.user.findMany({ where: { id: { in: moves.map((m) => m.actorId).filter((x): x is number => x !== null) } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name ?? u.email]));
    noStore(res).json({
      variant: { id: v.id, sku: v.sku, label: v.label, onHand: v.onHand, reserved: v.reserved, available: v.onHand - v.reserved, product: v.product },
      data: moves.map((m) => ({
        id: m.id.toString(), createdAt: m.createdAt.toISOString(), reason: m.reason, onHandDelta: m.onHandDelta, reservedDelta: m.reservedDelta,
        onHandAfter: m.onHandAfter, reservedAfter: m.reservedAfter, orderNumber: m.order?.orderNumber ?? null, importId: m.importId,
        returnRequestId: m.returnRequestId, note: m.note, actor: m.actorId === null ? null : (actors.get(m.actorId) ?? null),
      })),
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
    });
  });

  /** A workbook to count stock into, ready to upload as an inventory import (one row per live variant). */
  r.get('/inventory/count-sheet.xlsx', admin.can('inventory:read'), async (_req, res) => {
    const variants = await prisma.productVariant.findMany({ where: { deletedAt: null, product: { deletedAt: null } }, orderBy: [{ product: { name: 'asc' } }, { sortOrder: 'asc' }, { id: 'asc' }], select: { sku: true, label: true, onHand: true, product: { select: { name: true } } } });
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': XLSX, 'Content-Disposition': 'attachment; filename="artq-stock-count.xlsx"' }).send(await countSheet(variants.map((v) => ({ sku: v.sku, product: v.product.name, variant: v.label, onHand: v.onHand }))));
  });
}

export const COUNT_SHEET_COLUMNS = ['SKU', 'Product', 'Variant', 'On hand (system)', 'Counted quantity', 'Change (+/−)', 'Note'] as const;

/** The count sheet: fill "Counted quantity" (sets on hand) or "Change" (adds/removes), one per row; system columns are ignored. */
export async function countSheet(rows: { sku: string; product: string; variant: string; onHand: number }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Stock count', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COUNT_SHEET_COLUMNS.map((h) => ({ header: h, key: h, width: h === 'Product' ? 40 : 18 }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow({ SKU: r.sku, Product: r.product, Variant: r.variant, 'On hand (system)': r.onHand });
  const help = wb.addWorksheet('How to use');
  for (const line of [
    'Count each item and write the number in "Counted quantity". It replaces the stock on hand and marks the item as counted.',
    'Or write a change in "Change (+/−)" (e.g. -2 for two damaged units) with a note. Fill only one of the two per row.',
    'Leave both empty to skip a row. Units reserved by open orders are never changed by a count.',
    'Upload the file under Imports → Inventory counts.',
  ]) help.addRow([line]);
  help.getColumn(1).width = 110;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
