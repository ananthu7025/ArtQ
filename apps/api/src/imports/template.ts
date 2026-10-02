// The official template layout ("2. Products & Variants", and the result file we write back): one row per variant;
// consecutive rows with the same product (Product Key, else Product Name) form one product. Product fields left blank on
// later rows are taken from the product's first row. The optional "Flags" column carries review flags the client has not
// cleared yet; generic flags are always recomputed from the data.
import { slugify } from '@artq/shared';
import { bool, clean, list, type DraftRow } from './rows.js';
import { estimateFor } from './sheet1-profile.js';
import type { RawRow } from './workbook.js';

/** Flags that belong to a variant (the rest are product flags). */
export const VARIANT_FLAGS = new Set(['STOCK_AMBIGUOUS', 'SIZE_CONFLICT', 'PRICE_MISSING', 'PRICE_REVIEW', 'PRICE_CONFLICT', 'WEIGHT_ESTIMATED']);
const FLAG = /^[A-Z_]{3,40}$/;

export function templateDrafts(rows: RawRow[]): DraftRow[] {
  const out: DraftRow[] = [];
  let prevKey: string | null = null;
  let first: Record<string, unknown> = {};
  for (const r of rows) {
    const c = r.cells;
    const name = clean(c['product name']);
    const key: string = clean(c['product key']) ?? (name ? slugify(name, 120) : null) ?? prevKey ?? `row-${r.rowNumber}`;
    if (key !== prevKey) first = { ...c };
    prevKey = key;
    // Product-level cells: this row's value, else the product's first row.
    const p = (k: string) => clean(c[k]) ?? clean(first[k]);
    const flags = (clean(c.flags) ?? '').split(/[,;]/).map((f) => f.trim().toUpperCase()).filter((f) => FLAG.test(f));
    const messages = clean(c['is active']) !== null ? [{ code: 'IS_ACTIVE_IGNORED', text: '“Is Active” is ignored: products are published from the admin, after the readiness checks' }] : [];
    const productName = p('product name') ?? key;
    const estimate = estimateFor(p('subcategory'), productName);
    out.push({
      rowNumber: r.rowNumber, productKey: key, typeName: p('category'), categoryName: p('subcategory'),
      product: {
        name: productName, description: p('description'), details: list(p('product details')), care: list(p('specifications & care')),
        techniques: (p('techniques / occasions') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
        images: (p('product images') ?? '').split(/[,\s]+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)),
        metaTitle: p('meta title'), metaDescription: p('meta description'),
        isTrending: bool(c['is trending'] ?? first['is trending']), isNewArrival: bool(c['is new arrival'] ?? first['is new arrival']),
        flags: flags.filter((f) => !VARIANT_FLAGS.has(f)),
      },
      variant: {
        sku: clean(c.sku), size: clean(c['size / volume']), color: clean(c.color), thickness: clean(c.thickness), imageUrl: clean(c['variant image url']),
        price: c['selling price'], mrp: c['mrp / orig price'], stock: c['stock quantity'], weightKg: c['parcel weight'], flags: flags.filter((f) => VARIANT_FLAGS.has(f)),
      },
      ...(estimate ? { estimateWeightG: estimate } : {}),
      // Products of one type may share copy (e.g. a family of frames); a real copy keeps its flag via the Flags column.
      ...(p('category') ? { descriptionFamily: p('category')! } : {}),
      messages,
    });
  }
  return out;
}
