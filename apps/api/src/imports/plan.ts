// Catalogue import, validation step (database.md §9 "VALIDATING → VALIDATED"): every parsed row is stored in
// product_import_rows with its payload, messages and the versions it was planned against (base_version), so a concurrent
// admin edit is detected at apply time instead of being overwritten.
import type { Prisma } from '@prisma/client';
import type { Db } from '../db/functions.js';
import type { CatalogRow, Message } from './rows.js';

export type RowPlan = {
  action: 'create' | 'update' | 'unchanged';
  productId: number | null; productVersion: number | null;
  variantId: number | null; variantVersion: number | null;
  /** The row sets or changes a price / MRP (needs pricing:write to confirm). */
  setsPrice: boolean;
  createMissing: boolean;
};
export type RowPayload = { row: CatalogRow; plan: RowPlan };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Plans every row against the current catalogue. Rows that cannot be applied are returned as failed with a message. */
export async function planRows(db: Db, rows: CatalogRow[], createMissing: boolean) {
  const skus = rows.map((r) => r.variant.sku);
  const keys = [...new Set(rows.map((r) => r.productKey))];
  const names = [...new Set(rows.map((r) => r.product.name))];
  const [variants, byKey, byName] = await Promise.all([
    db.productVariant.findMany({ where: { sku: { in: skus }, deletedAt: null } }),
    db.product.findMany({ where: { importKey: { in: keys }, deletedAt: null }, select: { id: true, importKey: true, version: true, name: true } }),
    db.product.findMany({ where: { name: { in: names }, importKey: null, deletedAt: null }, select: { id: true, name: true, version: true } }),
  ]);
  const variantBySku = new Map(variants.map((v) => [v.sku, v]));
  // Size / colour / thickness identify a variant within its product (variants_options_live_uq): two rows, or a row and an
  // existing variant with another SKU, that would end up with the same options are refused here instead of at apply.
  const options = (o: { size: string | null; color: string | null; thickness: string | null }) => JSON.stringify([o.size ?? '', o.color ?? '', o.thickness ?? '']);
  const productIds = [...new Set([...byKey, ...byName].map((p) => p.id))];
  const existing = productIds.length ? await db.productVariant.findMany({ where: { productId: { in: productIds }, deletedAt: null }, select: { productId: true, sku: true, size: true, color: true, thickness: true } }) : [];
  const takenInFile = new Map<string, number>();
  const describe = (o: { size: string | null; color: string | null; thickness: string | null }) => [o.size, o.color, o.thickness].filter(Boolean).join(' / ') || 'no size, colour or thickness';
  const out: { rowNumber: number; sku: string; productKey: string; payload: RowPayload; status: 'PENDING' | 'FAILED'; messages: Message[] }[] = [];
  for (const row of rows) {
    const messages = [...row.messages];
    // Identity: product by import key; on a first import, an existing product with exactly this name is adopted.
    const product = byKey.find((p) => p.importKey === row.productKey) ?? byName.find((p) => p.name === row.product.name) ?? null;
    const v = variantBySku.get(row.variant.sku) ?? null;
    let status: 'PENDING' | 'FAILED' = 'PENDING';
    if (v && product && v.productId !== product.id) {
      status = 'FAILED';
      messages.push({ code: 'SKU_OTHER_PRODUCT', text: `SKU ${row.variant.sku} belongs to another product; change the SKU or the product key` });
    }
    if (v && !product) {
      status = 'FAILED';
      messages.push({ code: 'SKU_OTHER_PRODUCT', text: `SKU ${row.variant.sku} already exists on a product that is not “${row.product.name}”` });
    }
    const opt = options(row.variant);
    const earlier = takenInFile.get(`${row.productKey}|${opt}`);
    if (earlier !== undefined) {
      status = 'FAILED';
      messages.push({ code: 'OPTIONS_DUPLICATE', text: `Row ${earlier} of this product already has ${describe(row.variant)}; give each variant a different size, colour or thickness` });
    } else takenInFile.set(`${row.productKey}|${opt}`, row.rowNumber);
    const twin = product ? existing.find((e) => e.productId === product.id && e.sku !== row.variant.sku && options(e) === opt) : undefined;
    if (twin && earlier === undefined) {
      status = 'FAILED';
      messages.push({ code: 'OPTIONS_TAKEN', text: `Variant ${twin.sku} of this product already has ${describe(row.variant)}; use its SKU to update it, or change the size, colour or thickness` });
    }
    const priceChanged = v ? (row.variant.price !== null && row.variant.price !== v.price) || (row.variant.price !== null && row.variant.mrp !== v.mrp) : row.variant.price !== null;
    const contentChanged = v ? !(same(v.size, row.variant.size) && same(v.color, row.variant.color) && same(v.thickness, row.variant.thickness)
      && same(v.dataFlags.filter((f) => f !== 'WEIGHT_ESTIMATED'), row.variant.flags.filter((f) => f !== 'WEIGHT_ESTIMATED')) && (row.variant.weightSource !== 'MEASURED' || v.weightG === row.variant.weightG)) : true;
    if (v && row.variant.stockText === null && row.variant.stock !== v.onHand) {
      messages.push({ code: 'STOCK_IGNORED', text: `Stock ${row.variant.stock} not applied: a catalogue import never changes stock (count it in Inventory)` });
    }
    out.push({
      rowNumber: row.rowNumber, sku: row.variant.sku, productKey: row.productKey, status, messages,
      payload: {
        row,
        plan: {
          action: !v ? 'create' : priceChanged || contentChanged || row.lead ? 'update' : 'unchanged',
          productId: product?.id ?? null, productVersion: product?.version ?? null,
          variantId: v?.id ?? null, variantVersion: v?.version ?? null,
          setsPrice: priceChanged, createMissing,
        },
      },
    });
  }
  return out;
}

export const asJson = (v: unknown) => v as Prisma.InputJsonValue;
