// Catalogue imports (database.md §9, task 2.7): UPLOADED → VALIDATING → VALIDATED → (confirm) IMPORTING →
// COMPLETED / COMPLETED_WITH_ERRORS / FAILED / CANCELLED.
// Apply runs in batches of 25 PENDING rows, one transaction per batch under a Postgres advisory lock, so a crash resumes
// from the remaining PENDING rows without duplicates; a row that keeps crashing its batch fails after 3 attempts.
import { can, type Role } from '@artq/shared';
import type { Media, PrismaClient } from '@prisma/client';
import * as fn from '../db/functions.js';
import type { Db } from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import { applyRow, type RowOutcome } from './apply-row.js';
import { parseCatalog, resultWorkbook } from './catalog-file.js';
import { asJson, planRows, type RowPayload } from './plan.js';
import type { Message } from './rows.js';
import { WorkbookError } from './workbook.js';

export const BATCH_SIZE = 25;
export const MAX_ATTEMPTS = 3;
const LOCK = 'artq:catalog-import';
const TX = { maxWait: 30_000, timeout: 120_000 } as const;

export type ImportDeps = {
  prisma: PrismaClient;
  /** Reads the uploaded workbook from private storage. */
  readFile: (media: Media) => Promise<Buffer>;
  /** Downloads a remote product image (SSRF-safe) and returns its media id. */
  ingestImage?: (url: string, userId: number | null) => Promise<number>;
  enqueue: { validate: (importId: number, createMissing: boolean) => Promise<void>; apply: (importId: number) => Promise<void> };
};
export type ImportActor = { userId: number; role: Role };
/** Test hook: called inside each batch transaction before it commits (throwing simulates a crash mid-batch). */
export type ApplyHooks = { beforeCommit?: (batch: number) => Promise<void> | void };

const notFound = () => new AppError(404, 'NOT_FOUND', 'Import not found');

export class ImportService {
  constructor(private readonly d: ImportDeps) {}

  private get prisma() { return this.d.prisma; }

  async create(input: { fileMediaId: number; createMissing: boolean; fileName?: string | undefined }, actor: ImportActor) {
    const file = await this.prisma.media.findUnique({ where: { id: input.fileMediaId } });
    if (!file || file.deletedAt || file.kind !== 'DOCUMENT' || file.ownerScope !== 'import' || file.uploadedBy !== actor.userId) {
      throw new AppError(422, 'MEDIA_NOT_USABLE', 'Upload the .xlsx file first (catalogue import upload)');
    }
    if (['REJECTED', 'PENDING_UPLOAD'].includes(file.status)) throw new AppError(422, 'MEDIA_NOT_USABLE', file.status === 'REJECTED' ? `The file was rejected: ${file.failureReason ?? 'not a valid .xlsx'}` : 'The upload has not finished');
    const imp = await this.prisma.productImport.create({
      data: { kind: 'CATALOG', fileMediaId: file.id, fileName: (input.fileName ?? file.key.split('/').pop() ?? 'catalogue.xlsx').slice(0, 200), createdBy: actor.userId },
    });
    await this.d.enqueue.validate(imp.id, input.createMissing);
    return imp;
  }

  /** Worker: parse and plan. The file must have passed media processing (magic-byte check) first. */
  async validate(importId: number, createMissing: boolean): Promise<'VALIDATED' | 'FAILED' | 'WAITING' | 'SKIPPED'> {
    const imp = await this.prisma.productImport.findUnique({ where: { id: importId }, include: { file: true } });
    if (!imp || !['UPLOADED', 'VALIDATING'].includes(imp.status)) return 'SKIPPED';
    if (imp.file.status === 'REJECTED' || imp.file.status === 'FAILED') return this.fail(importId, `The file was rejected: ${imp.file.failureReason ?? 'not a valid .xlsx'}`);
    if (imp.file.status !== 'READY') return 'WAITING';                              // the job retries later
    await this.prisma.productImport.updateMany({ where: { id: importId, status: 'UPLOADED' }, data: { status: 'VALIDATING' } });
    let parsed;
    try { parsed = await parseCatalog(await this.d.readFile(imp.file)); }
    catch (e) {
      if (e instanceof WorkbookError) return this.fail(importId, e.message);
      throw e;
    }
    const planned = await planRows(this.prisma, parsed.rows, createMissing);
    await this.prisma.$transaction(async (tx) => {
      await tx.productImportRow.deleteMany({ where: { importId } });     // a re-run of validation starts clean
      await tx.productImportRow.createMany({
        data: planned.map((r) => ({
          importId, rowNumber: r.rowNumber, sku: r.sku, productKey: r.productKey, payload: asJson(r.payload), status: r.status,
          messages: asJson(r.messages), baseVersion: r.payload.plan.variantVersion ?? r.payload.plan.productVersion,
        })),
      });
      await tx.productImport.update({
        where: { id: importId },
        data: { status: 'VALIDATED', validatedAt: new Date(), totalRows: planned.length, failedCount: planned.filter((r) => r.status === 'FAILED').length },
      });
    }, TX);
    return 'VALIDATED';
  }

  private async fail(importId: number, message: string): Promise<'FAILED'> {
    await this.prisma.productImport.update({ where: { id: importId }, data: { status: 'FAILED', completedAt: new Date() } });
    await this.prisma.auditLog.create({ data: { action: 'import.failed', entity: 'import', entityId: String(importId), after: { message } } });
    return 'FAILED';
  }

  /** Admin confirms a validated import. Rows that set prices need pricing:write (architecture.md §5.9). */
  async confirm(importId: number, actor: ImportActor) {
    const imp = await this.prisma.productImport.findUnique({ where: { id: importId } });
    if (!imp) throw notFound();
    if (imp.status !== 'VALIDATED') throw new AppError(422, 'INVALID_TRANSITION', `This import is ${imp.status.toLowerCase().replace(/_/g, ' ')}; only a checked import can be confirmed`);
    if (!can(actor.role, 'pricing:write')) {
      const pricing = await this.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM product_import_rows WHERE import_id = ${importId} AND status = 'PENDING' AND (payload->'plan'->>'setsPrice')::boolean`;
      if (Number(pricing[0]!.n) > 0) throw new AppError(403, 'FORBIDDEN', 'This file sets prices, which your role cannot change', { permission: 'pricing:write' });
    }
    const r = await this.prisma.productImport.updateMany({ where: { id: importId, status: 'VALIDATED' }, data: { status: 'IMPORTING' } });
    if (r.count !== 1) throw new AppError(409, 'INVALID_TRANSITION', 'This import was confirmed or cancelled by someone else');
    await this.prisma.auditLog.create({ data: { actorId: actor.userId, action: 'import.confirm', entity: 'import', entityId: String(importId) } });
    await this.d.enqueue.apply(importId);
  }

  async cancel(importId: number, actor: ImportActor) {
    const r = await this.prisma.productImport.updateMany({ where: { id: importId, status: { in: ['UPLOADED', 'VALIDATING', 'VALIDATED', 'IMPORTING'] } }, data: { status: 'CANCELLED', completedAt: new Date() } });
    if (r.count !== 1) {
      if (!(await this.prisma.productImport.findUnique({ where: { id: importId } }))) throw notFound();
      throw new AppError(422, 'INVALID_TRANSITION', 'This import has already finished');
    }
    // Rows already applied stay applied; the rest are skipped.
    await this.prisma.productImportRow.updateMany({ where: { importId, status: 'PENDING' }, data: { status: 'SKIPPED', messages: asJson([{ code: 'CANCELLED', text: 'Import cancelled before this row' }]) } });
    await this.prisma.auditLog.create({ data: { actorId: actor.userId, action: 'import.cancel', entity: 'import', entityId: String(importId) } });
  }

  /** Worker: apply every PENDING row, batch by batch. Safe to run again after a crash or alongside a second run. */
  async apply(importId: number, hooks: ApplyHooks = {}): Promise<'DONE' | 'SKIPPED'> {
    const imp = await this.prisma.productImport.findUnique({ where: { id: importId } });
    if (!imp || imp.status !== 'IMPORTING') return 'SKIPPED';
    for (let batch = 1; ; batch++) {
      const status = (await this.prisma.productImport.findUniqueOrThrow({ where: { id: importId }, select: { status: true } })).status;
      if (status !== 'IMPORTING') return 'SKIPPED';                        // cancelled meanwhile
      const rows = await this.prisma.productImportRow.findMany({ where: { importId, status: 'PENDING' }, orderBy: { rowNumber: 'asc' }, take: BATCH_SIZE });
      if (rows.length === 0) break;
      // Count the attempt first (committed on its own), so a batch that keeps crashing the process gives up.
      await this.prisma.productImportRow.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { attempts: { increment: 1 } } });
      const exhausted = rows.filter((r) => r.attempts + 1 > MAX_ATTEMPTS);
      for (const r of exhausted) {
        await this.prisma.productImportRow.update({ where: { id: r.id }, data: { status: 'FAILED', processedAt: new Date(), messages: asJson([...(r.messages as Message[]), { code: 'GAVE_UP', text: `Stopped after ${MAX_ATTEMPTS} attempts` }]) } });
      }
      const todo = rows.filter((r) => r.attempts + 1 <= MAX_ATTEMPTS);
      if (todo.length) await this.applyBatch(importId, imp.createdBy, todo.map((r) => ({ id: r.id, payload: r.payload as unknown as RowPayload, messages: r.messages as Message[] })), () => hooks.beforeCommit?.(batch));
    }
    await this.finish(importId);
    return 'DONE';
  }

  private async images(rows: { payload: RowPayload }[], userId: number): Promise<Map<string, number>> {
    const urls = [...new Set(rows.flatMap((r) => [...r.payload.row.product.images, ...(r.payload.row.variant.imageUrl ? [r.payload.row.variant.imageUrl] : [])]))];
    const out = new Map<string, number>();
    if (!this.d.ingestImage) return out;
    // Downloads happen before the transaction (no network inside a database transaction).
    for (const u of urls) { try { out.set(u, await this.d.ingestImage(u, userId)); } catch { /* reported on the row */ } }
    return out;
  }

  private async applyBatch(importId: number, actorId: number, batch: { id: number; payload: RowPayload; messages: Message[] }[], beforeCommit: () => Promise<void> | void) {
    let rows = batch;
    const images = await this.images(rows, actorId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;
      // Another worker may have applied these rows while this one waited for the lock: keep only rows still PENDING.
      const still = new Set((await tx.$queryRaw<{ id: number }[]>`SELECT id FROM product_import_rows WHERE id = ANY(${rows.map((r) => r.id)}) AND status = 'PENDING' FOR UPDATE`).map((r) => r.id));
      rows = rows.filter((r) => still.has(r.id));
      if (rows.length === 0) return;
      // Global lock order: existing variants ascending, then products ascending (database.md §4.1).
      const skus = rows.map((r) => r.payload.row.variant.sku);
      const variants = await tx.$queryRaw<{ id: number; product_id: number }[]>`SELECT id, product_id FROM product_variants WHERE sku = ANY(${skus}) AND deleted_at IS NULL ORDER BY id FOR NO KEY UPDATE`;
      const keys = rows.map((r) => r.payload.row.productKey);
      await tx.$queryRaw`SELECT id FROM products WHERE (import_key = ANY(${keys}) OR id = ANY(${variants.map((v) => v.product_id)})) AND deleted_at IS NULL ORDER BY id FOR NO KEY UPDATE`;
      const touched = new Set<number>();
      for (const r of rows) {
        await tx.$executeRawUnsafe('SAVEPOINT import_row');
        let outcome: RowOutcome;
        try {
          outcome = await applyRow(tx, r.payload, { importId, actorId, images, touched });
          // A live product must still pass every publication check (the editor's rule, product.md §8.7).
          if (outcome.productId !== null) {
            const [live] = await tx.$queryRaw<{ f: string[] }[]>`SELECT product_readiness_failures(p) AS f FROM products p WHERE id = ${outcome.productId} AND status = 'ACTIVE'`;
            if (live && live.f.length) {
              await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT import_row');
              outcome = { status: 'NEEDS_REVIEW', productId: outcome.productId, variantId: outcome.variantId, messages: [...outcome.messages, { code: 'UNPUBLISH_FIRST', text: `The product is live and would fail: ${live.f.join(', ')}. Unpublish it first.` }] };
            }
          }
        } catch (e) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT import_row');
          const text = e instanceof AppError ? e.message : `Could not apply: ${(e as Error).message.split('\n').at(-1)?.slice(0, 300)}`;
          await tx.productImportRow.update({ where: { id: r.id }, data: { status: 'FAILED', processedAt: new Date(), messages: asJson([...r.messages, { code: 'APPLY_FAILED', text }]) } });
          continue;
        }
        await tx.productImportRow.update({
          where: { id: r.id },
          data: { status: outcome.status, productId: outcome.productId, variantId: outcome.variantId, processedAt: new Date(), messages: asJson([...r.messages, ...outcome.messages]) },
        });
      }
      if (touched.size) {
        await fn.refreshProducts(tx, [...touched].sort((a, b) => a - b));
        await storeReadiness(tx, [...touched]);
      }
      await beforeCommit();
    }, TX);
  }

  private async finish(importId: number) {
    const counts = Object.fromEntries((await this.prisma.productImportRow.groupBy({ by: ['status'], where: { importId }, _count: { _all: true } })).map((g) => [g.status, g._count._all]));
    const n = (s: string) => counts[s] ?? 0;
    const r = await this.prisma.productImport.updateMany({
      where: { id: importId, status: 'IMPORTING' },
      data: {
        status: n('FAILED') + n('NEEDS_REVIEW') > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED', completedAt: new Date(),
        createdCount: n('CREATED'), updatedCount: n('UPDATED'), unchangedCount: n('UNCHANGED'), reviewCount: n('NEEDS_REVIEW'), failedCount: n('FAILED'),
      },
    });
    if (r.count) await this.prisma.auditLog.create({ data: { action: 'import.completed', entity: 'import', entityId: String(importId), after: counts } });
  }

  /**
   * Worker sweeper (every minute): an IMPORTING import with PENDING rows and no progress for 2 minutes lost its job
   * (e.g. the worker was killed); queue it again. Batches resume from the remaining PENDING rows.
   */
  async sweep(): Promise<number[]> {
    const stuck = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT i.id FROM product_imports i
       WHERE i.status = 'IMPORTING' AND EXISTS (SELECT 1 FROM product_import_rows r WHERE r.import_id = i.id AND r.status = 'PENDING')
         AND coalesce((SELECT max(processed_at) FROM product_import_rows r WHERE r.import_id = i.id), i.validated_at) < now() - interval '2 minutes'`;
    for (const s of stuck) await this.d.enqueue.apply(s.id);
    return stuck.map((s) => s.id);
  }

  /** NEEDS_REVIEW rows: apply over the current data (the admin looked at it), or skip. */
  async resolve(importId: number, rowId: number, action: 'apply' | 'skip', actor: ImportActor) {
    const row = await this.prisma.productImportRow.findFirst({ where: { id: rowId, importId } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Row not found');
    if (row.status !== 'NEEDS_REVIEW') throw new AppError(422, 'INVALID_TRANSITION', 'Only rows that need review can be resolved');
    const payload = row.payload as unknown as RowPayload;
    if (action === 'apply' && payload.plan.setsPrice && !can(actor.role, 'pricing:write')) throw new AppError(403, 'FORBIDDEN', 'This row sets prices, which your role cannot change', { permission: 'pricing:write' });
    const messages = row.messages as Message[];
    if (action === 'skip') {
      await this.prisma.productImportRow.update({ where: { id: row.id }, data: { status: 'SKIPPED', messages: asJson([...messages, { code: 'SKIPPED_BY_ADMIN', text: 'Skipped after review' }]) } });
    } else {
      const images = await this.images([{ payload }], actor.userId);
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;
        const touched = new Set<number>();
        const outcome = await applyRow(tx, payload, { importId, actorId: actor.userId, images, touched, force: true });
        const [live] = outcome.productId === null ? [] : await tx.$queryRaw<{ f: string[] }[]>`SELECT product_readiness_failures(p) AS f FROM products p WHERE id = ${outcome.productId} AND status = 'ACTIVE'`;
        if (live && live.f.length) throw new AppError(409, 'UNPUBLISH_FIRST', `The product is live and would fail: ${live.f.join(', ')}. Unpublish it first.`);
        if (touched.size) { await fn.refreshProducts(tx, [...touched].sort((a, b) => a - b)); await storeReadiness(tx, [...touched]); }
        await tx.productImportRow.update({ where: { id: row.id }, data: { status: outcome.status === 'NEEDS_REVIEW' ? 'UPDATED' : outcome.status, productId: outcome.productId, variantId: outcome.variantId, processedAt: new Date(), messages: asJson([...messages, ...outcome.messages, { code: 'APPLIED_BY_ADMIN', text: 'Applied after review' }]) } });
      }, TX);
    }
    await this.prisma.auditLog.create({ data: { actorId: actor.userId, action: `import.row_${action}`, entity: 'import', entityId: String(importId), after: { rowId, rowNumber: row.rowNumber } } });
    await this.recount(importId);
  }

  private async recount(importId: number) {
    const counts = Object.fromEntries((await this.prisma.productImportRow.groupBy({ by: ['status'], where: { importId }, _count: { _all: true } })).map((g) => [g.status, g._count._all]));
    const n = (s: string) => counts[s] ?? 0;
    await this.prisma.productImport.update({ where: { id: importId }, data: { createdCount: n('CREATED'), updatedCount: n('UPDATED'), unchangedCount: n('UNCHANGED'), reviewCount: n('NEEDS_REVIEW'), failedCount: n('FAILED') } });
  }

  /** The result workbook: every row with the SKU it got, its outcome, flags and messages (catalog.md §5). */
  async resultFile(importId: number): Promise<Buffer> {
    if (!(await this.prisma.productImport.findUnique({ where: { id: importId } }))) throw notFound();
    const rows = await this.prisma.productImportRow.findMany({ where: { importId }, orderBy: { rowNumber: 'asc' } });
    return resultWorkbook(rows.map((r) => ({ row: (r.payload as unknown as RowPayload).row, outcome: r.status, messages: r.messages as Message[] })));
  }
}

/** Stored readiness for drafts touched by an import (the editor reads it; live products are guarded above). */
async function storeReadiness(db: Db, ids: number[]) {
  await db.$executeRaw`UPDATE products p SET is_publishable = cardinality(product_readiness_failures(p)) = 0,
      readiness = jsonb_build_object('failures', to_jsonb(product_readiness_failures(p)), 'evaluatedAt', now())
    WHERE id = ANY(${ids}) AND status <> 'ACTIVE'`;
}
