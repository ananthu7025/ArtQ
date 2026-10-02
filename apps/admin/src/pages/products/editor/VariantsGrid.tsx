// Variants grid (product.md §7.4): every variant field in a spreadsheet-like table, "Generate variants" from sizes ×
// an option, multi-line paste fills a column downward, one "Save variants" for all changes. Price / MRP / cost columns
// are editable only with pricing:write (read-only with a lock otherwise). Each row is validated with the API's own
// schemas before anything is sent; errors show on the cell (red border + message under it).
import { formatINR } from '@artq/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, Trash2, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthProvider';
import { btn, FormDialog, VersionConflictDialog } from '../../../components/dialogs';
import { errorMessage } from '../../../components/feedback';
import { FormAlert, TextField } from '../../../components/form';
import type { EditorVariant, ProductPayload } from './schema';
import {
  contentBody, emptyCells, fromVariant, generateRows, isDirty, newKey, pasteColumn, pricingRequest, priceChanged, validateRow,
  type Field, type OptionKind, type Row, type RowErrors,
} from './variant-rows';

type TextCol = { field: Exclude<Field, 'isActive' | 'weightSource' | 'shippingClass' | 'imageMediaId'>; label: string; width: string; price?: boolean; numeric?: boolean };
const COLS: TextCol[] = [
  { field: 'sku', label: 'SKU', width: 'w-40' }, { field: 'label', label: 'Label', width: 'w-40' }, { field: 'size', label: 'Size', width: 'w-28' },
  { field: 'thickness', label: 'Thickness / depth', width: 'w-28' }, { field: 'color', label: 'Colour', width: 'w-28' }, { field: 'colorHex', label: 'Hex', width: 'w-24' },
  { field: 'weightG', label: 'Weight (g)', width: 'w-24', numeric: true },
];
const DIMS: TextCol[] = [{ field: 'lengthCm', label: 'L (cm)', width: 'w-20', numeric: true }, { field: 'widthCm', label: 'W (cm)', width: 'w-20', numeric: true }, { field: 'heightCm', label: 'H (cm)', width: 'w-20', numeric: true }];
const PRICES: TextCol[] = [{ field: 'price', label: 'Price (₹)', width: 'w-24', price: true, numeric: true }, { field: 'mrp', label: 'MRP (₹)', width: 'w-24', price: true, numeric: true }, { field: 'costPrice', label: 'Cost (₹)', width: 'w-24', price: true, numeric: true }];
const cell = 'h-9 w-full rounded border border-border-input bg-white px-2 text-sm text-ink-900';

function GenerateDialog({ onAdd, onClose }: { onAdd: (rows: Row[]) => void; onClose: () => void }) {
  const [prefix, setPrefix] = useState('');
  const [sizes, setSizes] = useState('');
  const [kind, setKind] = useState<OptionKind>('thickness');
  const [options, setOptions] = useState('');
  const rows = generateRows({ prefix, sizes: sizes.split(','), kind, options: options.split(',') });
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) onClose(); }} title="Generate variants" description="One row for every size and option. Review the rows, add prices, then save.">
      <div className="space-y-3">
        <TextField id="gen-prefix" label="SKU prefix" placeholder="TWF" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        <TextField id="gen-sizes" label="Sizes (comma-separated)" placeholder="4x6, 6x6, 8x8" value={sizes} onChange={(e) => setSizes(e.target.value)} />
        <div>
          <label htmlFor="gen-kind" className="block text-sm font-medium text-ink-900">Second option</label>
          <select id="gen-kind" className="mt-1 block h-11 w-full rounded-md border border-border-input bg-white px-3 text-ink-900" value={kind} onChange={(e) => setKind(e.target.value as OptionKind)}>
            <option value="thickness">Thickness / depth</option><option value="color">Colour</option><option value="none">None</option>
          </select>
        </div>
        {kind !== 'none' && <TextField id="gen-options" label="Option values (comma-separated)" placeholder="1 inch, 0.5 inch" value={options} onChange={(e) => setOptions(e.target.value)} />}
        <p className="text-sm text-ink-700" role="status">{rows.length} variant{rows.length === 1 ? '' : 's'}{rows[0] ? `, e.g. ${rows[0].cells.sku}` : ''}</p>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button type="button" className={`${btn} text-ink-900 hover:bg-surface-100`} onClick={onClose}>Cancel</button>
        <button type="button" disabled={rows.length === 0} className={`${btn} bg-brand-700 text-white disabled:opacity-60`} onClick={() => { onAdd(rows); onClose(); }}>Add {rows.length} rows</button>
      </div>
    </FormDialog>
  );
}

export function VariantsGrid({ product, canWrite, canPrice }: { product: ProductPayload; canWrite: boolean; canPrice: boolean }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() => product.variants.map(fromVariant));
  const [errors, setErrors] = useState<Record<string, RowErrors & { row?: string }>>({});
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [seenVariants, setSeenVariants] = useState(product.variants);
  const dirty = rows.filter(isDirty);

  // Fresh server data replaces untouched rows; rows with unsaved edits are kept as typed.
  if (product.variants !== seenVariants) {
    setSeenVariants(product.variants);
    setRows((rs) => [
      ...product.variants.map((v) => { const mine = rs.find((r) => r.id === v.id); return mine && isDirty(mine) && mine.version === v.version ? mine : fromVariant(v); }),
      ...rs.filter((r) => r.id === null),   // new rows not saved yet
    ]);
  }

  const set = (key: string, field: Field, v: string | boolean) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, cells: { ...r.cells, [field]: v } } : r)));
  const onPaste = (index: number, field: Exclude<Field, 'isActive'>) => (e: React.ClipboardEvent<HTMLInputElement>) => {
    const filled = pasteColumn(rows, index, field, e.clipboardData.getData('text'));
    if (filled) { e.preventDefault(); setRows(filled); }
  };

  const saveAll = async () => {
    const found: Record<string, RowErrors & { row?: string }> = {};
    for (const r of dirty) { const e = validateRow(r, canPrice); if (Object.keys(e).length) found[r.key] = e; }
    setErrors(found);
    if (Object.keys(found).length) { toast.error(`Fix the highlighted cells in ${Object.keys(found).length} row${Object.keys(found).length > 1 ? 's' : ''}`); return; }
    setSaving(true);
    let saved = 0;
    const failed: Record<string, RowErrors & { row?: string }> = {};
    for (const r of dirty) {
      try {
        let version = r.version;
        let id = r.id;
        const body = contentBody(r);
        if (id === null) { const v = await api.request<EditorVariant>('POST', `/admin/products/${product.id}/variants`, { body }); id = v.id; version = v.version; }
        else if (Object.keys(body).length) version = (await api.request<EditorVariant>('PATCH', `/admin/variants/${id}`, { body: { ...body, version } })).version;
        const pricing = canPrice && priceChanged(r) ? pricingRequest(r) : null;
        if (pricing) await api.request('PATCH', `/admin/variants/${id}/pricing`, { body: { price: pricing.price, mrp: pricing.mrp, ...(r.cells.costPrice.trim() !== '' || r.original?.costPrice ? { costPrice: pricing.costPrice } : {}), version } });
        // A new row that saved its content but not its price becomes an existing row, so a retry does not create it twice.
        saved++;
        setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, id, version, original: { ...x.cells } } : x)));
      } catch (e) {
        if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') { setConflict(true); failed[r.key] = { row: 'Changed by someone else. Reload to see the latest.' }; continue; }
        const details = e instanceof ApiError && e.code === 'VALIDATION_ERROR' && Array.isArray(e.details) ? e.details as { path: string; message: string }[] : null;
        const fixes = e instanceof ApiError ? (e.details as { failures?: { check: string; fix: string }[] } | undefined)?.failures : undefined;
        failed[r.key] = details ? Object.fromEntries(details.map((d) => [d.path, d.message])) : { row: fixes ? `${errorMessage(e)} ${fixes.map((f) => `${f.check}: ${f.fix}`).join(' ')}` : errorMessage(e) };
      }
    }
    setErrors(failed);
    setSaving(false);
    await qc.invalidateQueries({ queryKey: ['product', product.id] });
    await qc.invalidateQueries({ queryKey: ['products'] });
    if (saved) toast.success(`${saved} variant${saved > 1 ? 's' : ''} saved`);
    if (Object.keys(failed).length) toast.error(`${Object.keys(failed).length} row${Object.keys(failed).length > 1 ? 's' : ''} not saved`);
  };

  const input = (r: Row, i: number, c: TextCol) => {
    const err = errors[r.key]?.[c.field];
    const id = `${r.key}-${c.field}`;
    if (c.price && !canPrice) {
      const p = c.field === 'costPrice' ? null : (r.id !== null ? product.variants.find((v) => v.id === r.id)?.[c.field as 'price' | 'mrp'] ?? null : null);
      return <span className="flex h-9 items-center gap-1 text-sm text-ink-900">{p === null ? '—' : formatINR(p)}<Lock aria-label={`${c.label} is read-only for your role`} size={12} className="text-ink-700" /></span>;
    }
    return (
      <>
        <input id={id} aria-label={`${c.label}, row ${i + 1}`} className={cell} inputMode={c.numeric ? 'decimal' : undefined} disabled={!canWrite} value={r.cells[c.field]}
          onChange={(e) => set(r.key, c.field, e.target.value)} onPaste={onPaste(i, c.field)} aria-invalid={err ? true : undefined} aria-describedby={err ? `${id}-error` : undefined} />
        {err && <p id={`${id}-error`} className="mt-0.5 text-xs text-danger-700">{err}</p>}
      </>
    );
  };
  const select = (r: Row, i: number, field: 'weightSource' | 'shippingClass' | 'imageMediaId', label: string, options: [string, string][]) => {
    const err = errors[r.key]?.[field];
    const id = `${r.key}-${field}`;
    return (
      <>
        <select id={id} aria-label={`${label}, row ${i + 1}`} className={cell} disabled={!canWrite} value={r.cells[field]} onChange={(e) => set(r.key, field, e.target.value)} aria-invalid={err ? true : undefined} aria-describedby={err ? `${id}-error` : undefined}>
          {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {err && <p id={`${id}-error`} className="mt-0.5 text-xs text-danger-700">{err}</p>}
      </>
    );
  };
  const imageOptions: [string, string][] = [['', 'Product cover'], ...product.images.map((img, n) => [String(img.mediaId), `Image ${n + 1}${img.alt ? `: ${img.alt}` : ''}`] as [string, string])];
  const visibleCols = [...COLS, ...DIMS];

  return (
    <div className="space-y-3">
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${btn} border border-border-input text-ink-900 hover:bg-surface-100`} onClick={() => setGenerating(true)}><Wand2 aria-hidden size={16} className="mr-2" />Generate variants</button>
          <button type="button" className={`${btn} border border-border-input text-ink-900 hover:bg-surface-100`} onClick={() => setRows((rs) => [...rs, { key: newKey(), id: null, version: null, cells: emptyCells(), original: null }])}><Plus aria-hidden size={16} className="mr-2" />Add row</button>
          <span className="self-center text-sm text-ink-700">Tip: paste a column from a spreadsheet into the first cell to fill the rows below.</span>
        </div>
      )}
      <div className="overflow-x-auto rounded-md border border-surface-200">
        <table className="min-w-max border-collapse text-left text-sm">
          <caption className="sr-only">Variants</caption>
          <thead className="bg-surface-100 text-ink-700">
            <tr>
              <th scope="col" className="px-2 py-2 font-semibold">Active</th>
              {visibleCols.map((c) => <th key={c.field} scope="col" className={`px-2 py-2 font-semibold ${c.width}`}>{c.label}</th>)}
              <th scope="col" className="w-32 px-2 py-2 font-semibold">Weight is</th>
              <th scope="col" className="w-32 px-2 py-2 font-semibold">Shipping</th>
              <th scope="col" className="w-36 px-2 py-2 font-semibold">Image</th>
              {PRICES.map((c) => <th key={c.field} scope="col" className={`px-2 py-2 font-semibold ${c.width}`}>{c.label}</th>)}
              <th scope="col" className="px-2 py-2 font-semibold">Stock</th>
              <th scope="col" className="px-2 py-2"><span className="sr-only">Row actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={visibleCols.length + 9} className="px-3 py-6 text-center text-ink-700">No variants yet. Generate them from sizes and options, or add a row.</td></tr>}
            {rows.map((r, i) => {
              const v = r.id !== null ? product.variants.find((x) => x.id === r.id) : undefined;
              return [
                <tr key={r.key} className={`border-t border-surface-200 align-top ${isDirty(r) ? 'bg-warning-bg/40' : ''}`} data-testid={`variant-row-${i}`}>
                  <td className="px-2 py-1"><input type="checkbox" className="mt-2.5 h-4 w-4 accent-brand-700" aria-label={`Active, row ${i + 1}`} disabled={!canWrite} checked={r.cells.isActive} onChange={(e) => set(r.key, 'isActive', e.target.checked)} /></td>
                  {visibleCols.map((c) => <td key={c.field} className={`px-1 py-1 ${c.width}`}>{input(r, i, c)}</td>)}
                  <td className="px-1 py-1">{select(r, i, 'weightSource', 'Weight is', [['', 'Not set'], ['MEASURED', 'Measured'], ['ESTIMATED', 'Estimated']])}</td>
                  <td className="px-1 py-1">{select(r, i, 'shippingClass', 'Shipping class', [['STANDARD', 'Standard'], ['BULKY', 'Bulky'], ['SURFACE_ONLY', 'Surface only']])}</td>
                  <td className="px-1 py-1">{select(r, i, 'imageMediaId', 'Image', imageOptions)}</td>
                  {PRICES.map((c) => <td key={c.field} className={`px-1 py-1 ${c.width}`}>{input(r, i, c)}</td>)}
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums text-ink-700">{v ? `${v.available} avail. (${v.onHand}/${v.reserved})` : 'New'}</td>
                  <td className="px-1 py-1">{r.id === null && canWrite && <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded text-danger-700 hover:bg-surface-100" aria-label={`Remove new row ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 aria-hidden size={16} /></button>}</td>
                </tr>,
                errors[r.key]?.row ? <tr key={`${r.key}-err`}><td colSpan={visibleCols.length + 9} className="px-2 pb-2"><FormAlert>Row {i + 1}: {errors[r.key]!.row}</FormAlert></td></tr> : null,
              ];
            })}
          </tbody>
        </table>
      </div>
      {canWrite && (
        <div className="flex items-center justify-end gap-3">
          <span className="text-sm text-ink-700" role="status">{dirty.length ? `${dirty.length} unsaved row${dirty.length > 1 ? 's' : ''}` : 'All variants saved'}</span>
          <button type="button" disabled={saving || dirty.length === 0} aria-busy={saving || undefined} className={`${btn} bg-brand-700 text-white disabled:opacity-60`} onClick={() => void saveAll()}>{saving ? 'Saving…' : 'Save variants'}</button>
        </div>
      )}
      {generating && <GenerateDialog onClose={() => setGenerating(false)} onAdd={(add) => setRows((rs) => [...rs, ...add])} />}
      <VersionConflictDialog open={conflict} entity="variant" onKeepEditing={() => setConflict(false)}
        onReload={() => { setConflict(false); setRows(product.variants.map(fromVariant)); setErrors({}); void qc.invalidateQueries({ queryKey: ['product', product.id] }); }} />
    </div>
  );
}
