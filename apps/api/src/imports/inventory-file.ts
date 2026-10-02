// Inventory count files (database.md §9 INVENTORY): SKU + "Counted quantity" (sets on hand, marks it counted) or
// "Change (+/−)" (adds or removes units; a note is required, as on the Inventory page). On-hand only, never prices.
import ExcelJS from 'exceljs';
import { clean } from './rows.js';
import { headerKey, WorkbookError, type Cell } from './workbook.js';

export type CountRow = {
  rowNumber: number; sku: string | null; kind: 'RECOUNT' | 'ADJUSTMENT' | null; quantity: number | null; note: string | null;
  status: 'PENDING' | 'FAILED' | 'SKIPPED'; messages: { code: string; text: string }[];
};

const MAX_ROWS = 10_000;
const int = (v: Cell): number | null => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  const s = clean(v)?.replace(/^\+/, '').replace(/−/g, '-');
  if (s === null || s === undefined) return null;
  return /^-?\d+$/.test(s) ? Number(s) : NaN;
};

export async function parseCountSheet(buffer: Buffer | ArrayBuffer): Promise<CountRow[]> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer as ArrayBuffer); } catch { throw new WorkbookError('This file is not a readable .xlsx workbook'); }
  for (const ws of wb.worksheets) {
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, col) => { headers[col - 1] = headerKey(String(c.value ?? '')); });
    const col = (name: string) => headers.indexOf(name) + 1;
    const [skuCol, countCol, changeCol, noteCol] = [col('sku'), col('counted quantity'), col('change'), col('note')];
    if (!skuCol || (!countCol && !changeCol)) continue;
    const out: CountRow[] = [];
    const seen = new Map<string, number>();
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const v = (c: number): Cell => { if (!c) return null; const x = row.getCell(c).value; return x && typeof x === 'object' && 'result' in x ? (x.result as Cell) : (x as Cell); };
      const sku = clean(v(skuCol))?.toUpperCase() ?? null;
      const count = int(v(countCol)), change = int(v(changeCol));
      const note = clean(v(noteCol))?.slice(0, 300) ?? null;
      const r: CountRow = { rowNumber: n, sku, kind: null, quantity: null, note, status: 'PENDING', messages: [] };
      const fail = (code: string, text: string) => { r.status = 'FAILED'; r.messages.push({ code, text }); };
      if (count === null && change === null) { r.status = 'SKIPPED'; r.messages.push({ code: 'NOTHING_TO_DO', text: 'No count or change on this row' }); }
      else if (!sku) fail('SKU_MISSING', 'No SKU on this row');
      else if (count !== null && change !== null) fail('BOTH_FILLED', 'Fill either the counted quantity or the change, not both');
      else if (Number.isNaN(count) || Number.isNaN(change)) fail('NOT_A_NUMBER', 'Use a whole number of units');
      else if (count !== null && count < 0) fail('NEGATIVE_COUNT', 'A count cannot be negative');
      else if (count !== null && count > 100_000 || change !== null && Math.abs(change) > 100_000) fail('TOO_LARGE', 'At most 100000 units');
      else if (change === 0) { r.status = 'SKIPPED'; r.messages.push({ code: 'NOTHING_TO_DO', text: 'A change of 0 does nothing' }); }
      else if (change !== null && !note) fail('NOTE_REQUIRED', 'Give a reason in the Note column for a change');
      else { r.kind = count !== null ? 'RECOUNT' : 'ADJUSTMENT'; r.quantity = count ?? change; }
      if (sku && r.status === 'PENDING') {
        const first = seen.get(sku);
        if (first) fail('SKU_DUPLICATE', `SKU ${sku} is already on row ${first}`);
        else seen.set(sku, n);
      }
      out.push(r);
    });
    if (out.length === 0) throw new WorkbookError(`Sheet “${ws.name}” has no rows`);
    if (out.length > MAX_ROWS) throw new WorkbookError(`At most ${MAX_ROWS} rows per import`);
    return out;
  }
  throw new WorkbookError('No sheet has the count columns (SKU and Counted quantity or Change). Download the count sheet from Inventory.');
}
