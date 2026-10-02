// Variant grid rows (product.md §7.4): cells are edited as text, converted to the API shapes and validated with the API's
// own schemas (createVariantBody / updateVariantBody fields, pricingBody) before anything is sent (CLAUDE.md
// "Validation rule"). Pure functions, unit-tested in test/variant-rows.test.ts.
import { createVariantBody, pricingBody, variantContent } from '@artq/shared';
import type { EditorVariant } from './schema';

export const CONTENT_FIELDS = ['isActive', 'sku', 'label', 'size', 'color', 'colorHex', 'thickness', 'weightG', 'weightSource', 'lengthCm', 'widthCm', 'heightCm', 'shippingClass', 'imageMediaId'] as const;
export const PRICE_FIELDS = ['price', 'mrp', 'costPrice'] as const;
export type ContentField = (typeof CONTENT_FIELDS)[number];
export type PriceField = (typeof PRICE_FIELDS)[number];
export type Field = ContentField | PriceField;
export type Cells = Record<Exclude<Field, 'isActive'>, string> & { isActive: boolean };
export type Row = { key: string; id: number | null; version: number | null; cells: Cells; original: Cells | null };
export type RowErrors = Partial<Record<Field, string>>;

const NUMBER_FIELDS = new Set<Field>(['weightG', 'lengthCm', 'widthCm', 'heightCm', 'imageMediaId']);
const UPPER = new Set<Field>(['colorHex']);
const RUPEES = /^\d{1,7}(\.\d{1,2})?$/;

const s = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));
const rupees = (p: number | null | undefined) => (p === null || p === undefined ? '' : (p / 100).toFixed(2).replace(/\.00$/, ''));
let seq = 0;
export const newKey = () => `new-${++seq}`;

export function emptyCells(): Cells {
  return { isActive: true, sku: '', label: '', size: '', color: '', colorHex: '', thickness: '', weightG: '', weightSource: '', lengthCm: '', widthCm: '', heightCm: '', shippingClass: 'STANDARD', imageMediaId: '', price: '', mrp: '', costPrice: '' };
}

export function fromVariant(v: EditorVariant): Row {
  const cells: Cells = {
    isActive: v.isActive, sku: v.sku, label: v.label, size: s(v.size), color: s(v.color), colorHex: s(v.colorHex), thickness: s(v.thickness),
    weightG: s(v.weightG), weightSource: s(v.weightSource), lengthCm: s(v.lengthCm), widthCm: s(v.widthCm), heightCm: s(v.heightCm),
    shippingClass: v.shippingClass, imageMediaId: s(v.imageMediaId), price: rupees(v.price), mrp: rupees(v.mrp), costPrice: rupees(v.costPrice),
  };
  return { key: `v${v.id}`, id: v.id, version: v.version, cells, original: { ...cells } };
}

/** Text cell → API value: blank = null (or omitted for a new row), numbers parsed (NaN is reported by the schema). */
function value(f: ContentField, cells: Cells): unknown {
  if (f === 'isActive') return cells.isActive;
  const raw = cells[f].trim();
  if (raw === '') return null;
  if (NUMBER_FIELDS.has(f)) return Number(raw);
  return UPPER.has(f) ? raw.toUpperCase() : raw;
}

export const changed = (r: Row, f: Field) => r.original === null || r.cells[f] !== r.original[f];
export const isDirty = (r: Row) => [...CONTENT_FIELDS, ...PRICE_FIELDS].some((f) => changed(r, f));

/** Content request body for a row (new: only filled cells; existing: only changed cells). */
export function contentBody(r: Row): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of CONTENT_FIELDS) {
    if (r.id === null ? (f === 'isActive' ? true : r.cells[f].trim() !== '' || f === 'shippingClass') : changed(r, f)) {
      const v = value(f, r.cells);
      if (!(r.id === null && v === null)) body[f] = v;
    }
  }
  return body;
}

const toPaise = (raw: string) => (raw.trim() === '' ? null : Math.round(Number(raw.trim()) * 100));
export const priceChanged = (r: Row) => PRICE_FIELDS.some((f) => changed(r, f));

/** Pricing request body, or null when the price cells are untouched (or all blank on a new row). */
export function pricingRequest(r: Row): { price: number | null; mrp: number | null; costPrice: number | null } | null {
  if (!priceChanged(r)) return null;
  if (r.id === null && PRICE_FIELDS.every((f) => r.cells[f].trim() === '')) return null;
  return { price: toPaise(r.cells.price), mrp: toPaise(r.cells.mrp), costPrice: toPaise(r.cells.costPrice) };
}

/** Field errors for a row, with the API's messages. Prices only when the user may set them. */
export function validateRow(r: Row, canPrice: boolean): RowErrors {
  const errors: RowErrors = {};
  const content = contentBody(r);
  const parsed = r.id === null ? createVariantBody.safeParse(content) : variantContent.partial().safeParse(content);
  if (!parsed.success) for (const i of parsed.error.issues) { const f = i.path[0] as Field; errors[f] ??= i.message; }
  if (canPrice) {
    for (const f of PRICE_FIELDS) if (r.cells[f].trim() !== '' && !RUPEES.test(r.cells[f].trim())) errors[f] ??= 'Use rupees, e.g. 210 or 210.50';
    const p = pricingRequest(r);
    if (p && !errors.price && !errors.mrp && !errors.costPrice) {
      if (p.price === null) errors.price = 'Enter a price';
      else {
        const res = pricingBody.safeParse({ ...p, version: 1 });
        if (!res.success) for (const i of res.error.issues) { const f = i.path[0] as Field; errors[f] ??= i.message; }
      }
    }
  }
  return errors;
}

/** "1 inch" → "1IN", "0.5 inch" → "05IN", "4x6" → "4X6", "Gold" → "GOLD": the code used in generated SKUs. */
export function skuCode(v: string): string {
  return v.trim().toUpperCase().replace(/INCHES|INCH|"/g, 'IN').replace(/[^A-Z0-9]+/g, '');
}

export type OptionKind = 'thickness' | 'color' | 'none';
/** Rows for every size × option, with SKUs `PREFIX-OPTION-SIZE` (or `PREFIX-SIZE`). */
export function generateRows(o: { prefix: string; sizes: string[]; kind: OptionKind; options: string[] }): Row[] {
  const sizes = o.sizes.map((x) => x.trim()).filter(Boolean);
  const options = o.kind === 'none' ? [''] : o.options.map((x) => x.trim()).filter(Boolean);
  const prefix = skuCode(o.prefix);
  const rows: Row[] = [];
  for (const opt of options) {
    for (const size of sizes) {
      const cells = emptyCells();
      cells.size = size;
      if (o.kind !== 'none') cells[o.kind] = opt;
      cells.sku = [prefix, opt && skuCode(opt), skuCode(size)].filter(Boolean).join('-');
      rows.push({ key: newKey(), id: null, version: null, cells, original: null });
    }
  }
  return rows;
}

/** Spreadsheet paste: multi-line text fills `field` downward from `fromIndex` (existing rows only). */
export function pasteColumn(rows: Row[], fromIndex: number, field: Exclude<Field, 'isActive'>, text: string): Row[] | null {
  const values = text.replace(/\r/g, '').split('\n');
  if (values.at(-1) === '') values.pop();
  if (values.length < 2) return null;
  // Prices pasted from a sheet may carry "₹" and thousands separators; other columns are kept as typed.
  const clean = (v: string) => ((PRICE_FIELDS as readonly string[]).includes(field) ? v.trim().replace(/^₹\s?/, '').replace(/,/g, '') : v.trim());
  return rows.map((r, i) => (i >= fromIndex && i - fromIndex < values.length ? { ...r, cells: { ...r.cells, [field]: clean(values[i - fromIndex]!) } } : r));
}
