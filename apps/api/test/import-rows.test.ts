// Catalogue import rules (database.md §9, catalog.md §4–§6), without a database.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../src/imports/catalog-file.js';
import { finalizeRows, paise, stockUnits, type DraftRow } from '../src/imports/rows.js';
import { applyFailure } from '../src/imports/service.js';

const draft = (o: Partial<DraftRow['variant']> & { key?: string; desc?: string | null; family?: string; productFlags?: string[] } = {}): DraftRow => ({
  rowNumber: 2, productKey: o.key ?? 'p', typeName: 'T', categoryName: 'C',
  product: { name: 'P', description: o.desc ?? null, details: [], care: [], techniques: [], images: [], metaTitle: null, metaDescription: null, isTrending: null, isNewArrival: null, flags: o.productFlags ?? [] },
  // `in` (not ??): an explicit null means an empty cell.
  variant: { sku: 'sku' in o ? o.sku! : 'SKU-1', size: o.size ?? '1 kg', color: o.color ?? null, thickness: null, imageUrl: null, price: 'price' in o ? o.price : 100, mrp: o.mrp ?? null, stock: 'stock' in o ? o.stock : 5, weightKg: o.weightKg ?? null, flags: o.flags ?? [] },
  ...(o.family ? { descriptionFamily: o.family } : {}),
  messages: [],
});
const one = (o: Parameters<typeof draft>[0]) => finalizeRows([draft(o)])[0]!;

describe('cell values', () => {
  it.each([[499, 49_900], ['1,499', 149_900], ['₹ 90', 9000], ['12.5', 1250], [0, null], [-5, null], ['abc', null], ['', null], [null, null], ['1.234', null]])('paise(%j) = %j', (v, out) => {
    expect(paise(v)).toBe(out);
  });
  it.each([[20, 20], ['7', 7], [0, 0], ['500KG', null], ['Stock Out', null], [null, null], [2.5, null], [-1, null], ['All stock available . Pls put min 20 count stock', null]])('stockUnits(%j) = %j', (v, out) => {
    expect(stockUnits(v)).toBe(out);
  });
});

describe('rules', () => {
  it('stock text is never guessed: 0, STOCK_AMBIGUOUS, the text kept for the result file', () => {
    expect(one({ stock: '500KG' }).variant).toMatchObject({ stock: 0, stockText: '500KG', flags: ['STOCK_AMBIGUOUS'] });
    expect(one({ stock: null }).variant).toMatchObject({ stock: 0, flags: ['STOCK_AMBIGUOUS'] });
    expect(one({ stock: 12 }).variant).toMatchObject({ stock: 12, stockText: null, flags: [] });
  });

  it('no price ⇒ PRICE_MISSING; MRP below the price is dropped and flagged; equal MRP is kept', () => {
    expect(one({ price: null }).variant).toMatchObject({ price: null, flags: ['PRICE_MISSING'] });
    expect(one({ price: 200, mrp: 150 }).variant).toMatchObject({ mrp: null, flags: ['PRICE_REVIEW'] });
    expect(one({ price: 200, mrp: 200 }).variant).toMatchObject({ mrp: 20_000, flags: [] });
  });

  it('sizes: normalised; no unit ⇒ SIZE_CONFLICT; free text kept without net quantity', () => {
    expect(one({ size: '500GM' }).variant).toMatchObject({ size: '500 gm', netQuantity: 500, netUnit: 'G' });
    expect(one({ size: '10' }).variant).toMatchObject({ size: '10', netQuantity: null, flags: ['SIZE_CONFLICT'] });
    expect(one({ size: 'Set of 9 colours' }).variant).toMatchObject({ size: 'Set of 9 colours', netQuantity: null, flags: [] });
    // Words after the size are kept: they are what tells two variants apart (“10 g Red” / “10 g Blue”).
    expect(one({ size: '10 g Red' }).variant).toMatchObject({ size: '10 gm Red', netQuantity: 10, netUnit: 'G' });
    expect(one({ size: '12X16 Double Frame' }).variant).toMatchObject({ size: '12×16 in Double Frame', netQuantity: 1, netUnit: 'PCS' });
    expect(one({ size: `10 g ${'x'.repeat(80)}` }).variant.size).toHaveLength(60);   // the column holds 60
    expect(one({ size: `10 g ${'x'.repeat(54)}` }).variant.size).toBe(`10 gm ${'x'.repeat(54)}`);   // exactly 60 kept whole
  });

  it('weight: measured from kg, else the category estimate flagged WEIGHT_ESTIMATED, else none', () => {
    expect(one({ weightKg: 0.35 }).variant).toMatchObject({ weightG: 350, weightSource: 'MEASURED', flags: [] });
    const est = finalizeRows([{ ...draft({}), estimateWeightG: () => 345 }])[0]!.variant;
    expect(est).toMatchObject({ weightG: 345, weightSource: 'ESTIMATED', flags: ['WEIGHT_ESTIMATED'] });
    expect(one({}).variant).toMatchObject({ weightG: null, weightSource: null });
  });

  it('copied descriptions are flagged on the later product, not within a family or a product', () => {
    const rows = finalizeRows([draft({ key: 'a', desc: 'Pearl White, fine mica.', sku: 'A' }), draft({ key: 'a', desc: 'Pearl White, fine mica.', sku: 'A2' }), draft({ key: 'b', desc: 'pearl white fine mica', sku: 'B' })]);
    expect(rows.map((r) => r.product.flags)).toEqual([[], [], ['DESCRIPTION_SUSPECT_COPY']]);
    const family = finalizeRows([draft({ key: 'x', desc: 'Teak frames.', family: 'teak', sku: 'X' }), draft({ key: 'y', desc: 'Teak frames.', family: 'teak', sku: 'Y' })]);
    expect(family.map((r) => r.product.flags)).toEqual([[], []]);
  });

  it('SKUs: generated when blank, upper-cased, and made unique within the file', () => {
    const rows = finalizeRows([draft({ sku: null, size: '1 kg' }), draft({ sku: 'dup' }), draft({ sku: 'DUP' })]);
    expect(rows.map((r) => r.variant.sku)).toEqual(['T-C-1KG', 'DUP', 'DUP-2']);
    expect(rows[0]!.messages.map((m) => m.code)).toContain('SKU_GENERATED');
    expect(rows[2]!.messages.map((m) => m.code)).toContain('SKU_DUPLICATE');
  });

  it('the first row of a product leads; product keys become URL-safe; "NA" is empty', () => {
    const rows = finalizeRows([draft({ key: 'Metallic Gold gel pigment', color: 'NA', sku: 'G1' }), draft({ key: 'Metallic Gold gel pigment', sku: 'G2' })]);
    expect(rows.map((r) => [r.productKey, r.lead])).toEqual([['metallic-gold-gel-pigment', true], ['metallic-gold-gel-pigment', false]]);
    expect(rows[0]!.variant.color).toBeNull();
  });
});

describe('template layout', () => {
  it('product fields come from the first row; Is Active is ignored with a note; the Flags column is kept', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('2. Products & Variants');
    ws.addRow(['Category (Type) *', 'Subcategory *', 'Product Name *', 'Description *', 'Size / Volume *', 'Selling Price (₹) *', 'Stock Quantity *', 'SKU', 'Is Active (TRUE/FALSE)', 'Flags', 'Techniques / Occasions']);
    ws.addRow(['Resins', 'UV Resin', 'UV Resin', 'Clear UV resin', '50 gm', 180, 10, 'RES-UV-50G', 'TRUE', 'PRICE_CONFLICT, COPY_REVIEW', 'Resin Art, Jewellery Making']);
    ws.addRow(['Resins', 'UV Resin', 'UV Resin', null, '100 gm', 310, 10, 'RES-UV-100G', null, null, null]);
    const { layout, rows } = await parseCatalog(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(layout).toBe('TEMPLATE');
    expect(rows[1]!.product).toMatchObject({ description: 'Clear UV resin', techniques: ['Resin Art', 'Jewellery Making'] });
    expect(rows[0]!.messages.map((m) => m.code)).toContain('IS_ACTIVE_IGNORED');
    expect(rows[0]!.variant.flags).toEqual(['PRICE_CONFLICT', 'WEIGHT_ESTIMATED']);   // no parcel weight: UV resin estimate
    expect(rows[0]!.product.flags).toEqual(['COPY_REVIEW']);
    expect(rows[1]!.messages.map((m) => m.code)).not.toContain('IS_ACTIVE_IGNORED');
  });
});

describe('applyFailure: database refusals in plain words', () => {
  it('names what is duplicated instead of index and column names', () => {
    expect(applyFailure({ code: 'P2002', message: 'Unique constraint failed on the fields: (`product_id`,`COALESCE(size`)', meta: { target: ['product_id'] } })).toBe('Could not apply: another variant of this product already has this size, colour and thickness');
    expect(applyFailure({ code: 'P2002', message: 'x', meta: { target: ['sku'] } })).toBe('Could not apply: this SKU is already used by another variant');
    expect(applyFailure({ message: 'duplicate key value violates unique constraint "products_slug_key"' })).toBe('Could not apply: another product already uses this name in its web address (slug)');
    expect(applyFailure({ code: 'P2002', message: 'x', meta: { target: ['email'] } })).toBe('Could not apply: a value on this row is already used elsewhere');
  });
  it('anything else keeps the last line of the error, at most 300 characters', () => {
    expect(applyFailure(new Error(`first\n${'y'.repeat(400)}`))).toBe(`Could not apply: ${'y'.repeat(300)}`);
    expect(applyFailure('boom')).toBe('Could not apply: boom');
  });
});
