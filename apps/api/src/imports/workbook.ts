// Reads a catalogue workbook (exceljs) into raw rows keyed by header, and detects its layout (database.md §9):
//   SHEET1    the client's latest list (catalog.md "Sheet1": no SKU column; product cells filled only on a product's
//             first row). Preferred when present, because it is the most complete.
//   TEMPLATE  the official import template ("2. Products & Variants", or our cleaned result file).
import ExcelJS from 'exceljs';

export type Layout = 'SHEET1' | 'TEMPLATE';
export type Cell = string | number | boolean | null;
export type RawRow = { rowNumber: number; cells: Record<string, Cell> };
export type Workbook = { layout: Layout; sheet: string; headers: string[]; rows: RawRow[] };

export class WorkbookError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkbookError'; }
}

/** "Selling Price (₹) *" → "selling price": lower case, no marks, no parenthesised hints. */
export function headerKey(h: string): string {
  return h.replace(/\(.*?\)/g, '').replace(/[*:]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function cellValue(c: ExcelJS.Cell): Cell {
  const v = c.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return (v.result as Cell) ?? null;                       // formula
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim() || null;
    if ('text' in v) return String(v.text).trim() || null;                      // hyperlink
  }
  return String(v);
}

function readSheet(ws: ExcelJS.Worksheet): { headers: string[]; rows: RawRow[] } {
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (c, col) => { headers[col - 1] = headerKey(String(c.value ?? '')); });
  const rows: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const cells: Record<string, Cell> = {};
    headers.forEach((h, i) => { if (h) cells[h] = cellValue(row.getCell(i + 1)); });
    if (Object.values(cells).some((v) => v !== null)) rows.push({ rowNumber: n, cells });
  });
  return { headers: headers.filter(Boolean), rows };
}

const SHEET1_HEADERS = ['category', 'subcategory', 'product name', 'size / volume', 'selling price', 'stock quantity'];
const TEMPLATE_HEADERS = ['category', 'subcategory', 'product name', 'size / volume', 'selling price', 'stock quantity', 'sku'];
const MAX_ROWS = 5000;

export async function readWorkbook(buffer: Buffer | ArrayBuffer): Promise<Workbook> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer as ArrayBuffer); }
  catch { throw new WorkbookError('This file is not a readable .xlsx workbook'); }
  const sheets = wb.worksheets.map((ws) => ({ ws, ...readSheet(ws) }));
  const has = (hs: string[], need: string[]) => need.every((n) => hs.includes(n));
  // The client's Sheet1 (no SKU column) wins over the older template sheet in the same workbook.
  const sheet1 = sheets.find((s) => has(s.headers, SHEET1_HEADERS) && !s.headers.includes('sku'));
  const template = sheets.find((s) => has(s.headers, TEMPLATE_HEADERS));
  const pick = sheet1 ?? template;
  if (!pick) throw new WorkbookError('No sheet has the catalogue columns (Category, Subcategory, Product Name, Size / Volume, Selling Price, Stock Quantity). Download the template to see the layout.');
  if (pick.rows.length === 0) throw new WorkbookError(`Sheet “${pick.ws.name}” has no rows`);
  if (pick.rows.length > MAX_ROWS) throw new WorkbookError(`Sheet “${pick.ws.name}” has ${pick.rows.length} rows; at most ${MAX_ROWS} per import`);
  return { layout: pick === sheet1 ? 'SHEET1' : 'TEMPLATE', sheet: pick.ws.name, headers: pick.headers, rows: pick.rows };
}
