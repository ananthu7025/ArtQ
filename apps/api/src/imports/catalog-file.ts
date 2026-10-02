// Catalogue import files: workbook → rows (any supported layout), and rows + outcomes → the result workbook
// (catalog.md §5 "catalog.cleaned.xlsx"): the official template columns, our SKUs and product keys written back, plus
// Flags (what still blocks publication; the client clears a flag by fixing the data and deleting it), Outcome and
// Messages. Re-importing the result file updates by SKU and never touches stock or publication status.
import ExcelJS from 'exceljs';
import { finalizeRows, type CatalogRow } from './rows.js';
import { sheet1Drafts } from './sheet1-profile.js';
import { templateDrafts } from './template.js';
import { readWorkbook, type Layout } from './workbook.js';

export async function parseCatalog(buffer: Buffer | ArrayBuffer): Promise<{ layout: Layout; sheet: string; rows: CatalogRow[] }> {
  const wb = await readWorkbook(buffer);
  const drafts = wb.layout === 'SHEET1' ? sheet1Drafts(wb.rows) : templateDrafts(wb.rows);
  return { layout: wb.layout, sheet: wb.sheet, rows: finalizeRows(drafts) };
}

export const TEMPLATE_COLUMNS = [
  'Product Key', 'Category (Type) *', 'Subcategory *', 'Product Name *', 'Description *', 'Product Images (Comma-separated, 1st link is Cover)',
  'Size / Volume *', 'Color', 'Thickness', 'Variant Image URL (Optional)', 'Selling Price (₹) *', 'MRP / Orig Price (₹)', 'Stock Quantity *',
  'SKU', 'Parcel Weight (kg)', 'Techniques / Occasions', 'Is Trending (TRUE/FALSE)', 'Is New Arrival (TRUE/FALSE)',
  'Product Details (Separated by |)', 'Specifications & Care (Separated by |)', 'Meta Title (SEO)', 'Meta Description (SEO)', 'Flags',
] as const;

export type ResultRow = { row: CatalogRow; outcome: string | null; messages: { code: string; text: string }[] };

const rupees = (p: number | null) => (p === null ? null : p / 100);

function sheetWith(wb: ExcelJS.Workbook, name: string, columns: readonly string[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((h) => ({ header: h, key: h, width: Math.min(Math.max(h.length + 2, 12), 40) }));
  ws.getRow(1).font = { bold: true };
  return ws;
}

/** The result workbook: one row per imported row, in the template layout (re-importable). */
export async function resultWorkbook(rows: ResultRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ArtQ admin';
  const ws = sheetWith(wb, '2. Products & Variants', [...TEMPLATE_COLUMNS, 'Outcome', 'Messages']);
  for (const { row: r, outcome, messages } of rows) {
    const lead = r.lead;
    ws.addRow({
      'Product Key': r.productKey, 'Category (Type) *': r.typeName, 'Subcategory *': r.categoryName, 'Product Name *': r.product.name,
      'Description *': lead ? r.product.description : null, 'Product Images (Comma-separated, 1st link is Cover)': lead ? r.product.images.join(', ') || null : null,
      'Size / Volume *': r.variant.size, Color: r.variant.color, Thickness: r.variant.thickness, 'Variant Image URL (Optional)': r.variant.imageUrl,
      'Selling Price (₹) *': rupees(r.variant.price), 'MRP / Orig Price (₹)': rupees(r.variant.mrp),
      // Stock exactly as the sheet had it (ambiguous text stays visible); re-imports never change stock anyway.
      'Stock Quantity *': r.variant.stockText ?? r.variant.stock, SKU: r.variant.sku,
      'Parcel Weight (kg)': r.variant.weightSource === 'MEASURED' && r.variant.weightG !== null ? r.variant.weightG / 1000 : null,
      'Techniques / Occasions': lead ? r.product.techniques.join(', ') || null : null,
      'Is Trending (TRUE/FALSE)': r.product.isTrending === null ? null : String(r.product.isTrending).toUpperCase(),
      'Is New Arrival (TRUE/FALSE)': r.product.isNewArrival === null ? null : String(r.product.isNewArrival).toUpperCase(),
      'Product Details (Separated by |)': lead ? r.product.details.join(' | ') || null : null,
      'Specifications & Care (Separated by |)': lead ? r.product.care.join(' | ') || null : null,
      'Meta Title (SEO)': lead ? r.product.metaTitle : null, 'Meta Description (SEO)': lead ? r.product.metaDescription : null,
      Flags: [...r.product.flags, ...r.variant.flags.filter((f) => f !== 'WEIGHT_ESTIMATED')].join(', ') || null,
      Outcome: outcome, Messages: messages.map((m) => m.text).join(' · ') || null,
    });
  }
  const help = wb.addWorksheet('How to re-import');
  for (const line of [
    'Correct the data in "2. Products & Variants" and import this file again.',
    'Rows are matched by SKU (variants) and Product Key (products). Do not change them.',
    'Flags list what still blocks publishing. When you have fixed one, delete it from the Flags cell.',
    'Stock is never changed by a catalogue import: count stock with an inventory import or in Inventory.',
    'Prices are in rupees. Weights in kg (measured on the packed item).',
  ]) help.addRow([line]);
  help.getColumn(1).width = 110;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** An empty template to download. */
export async function templateWorkbook(): Promise<Buffer> {
  return resultWorkbook([]);
}
