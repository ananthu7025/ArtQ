// Inventory (product.md §7.5, api.md §4.5, task 2.8): on hand / reserved / available per variant; recount, adjustment and
// damage write-off (reason required); movement ledger; count sheet + inventory import; oversold first. On-hand only.
import { ADJUSTMENT_KINDS, adjustmentRow, type AdjustmentKind } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Download, Upload, X } from 'lucide-react';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import type { Page } from '../../api/client';
import { saveBlob } from '../../api/upload';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { btn, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, TextField } from '../../components/form';
import { PageHeader } from '../simple';

export type StockRow = {
  variantId: number; sku: string; label: string; product: { id: number; name: string; status: string };
  onHand: number; reserved: number; available: number; lowStockThreshold: number; countedAt: string | null; isActive: boolean;
};
type Movement = { id: string; createdAt: string; reason: string; onHandDelta: number; reservedDelta: number; onHandAfter: number; reservedAfter: number; orderNumber: string | null; importId: number | null; note: string | null; actor: string | null };

const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const pill = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold';
const FILTERS: [string, string][] = [['', 'All'], ['low', 'Low stock'], ['out', 'Out of stock'], ['oversold', 'Oversold'], ['uncounted', 'Not counted']];
export const REASON: Record<string, string> = {
  IMPORT_INITIAL: 'Imported (uncounted)', RECOUNT: 'Count', ADJUSTMENT: 'Adjustment', DAMAGE_WRITE_OFF: 'Damaged / written off', RESERVE: 'Reserved by an order',
  RELEASE: 'Reservation released', CONSUME: 'Shipped', RETURN_RESTOCK: 'Return restocked', RETURN_DAMAGED: 'Return damaged', RTO_RESTOCK: 'Returned to origin', LOST_WRITE_OFF: 'Lost in transit',
};
const KINDS: { value: AdjustmentKind; label: string; help: string; quantityLabel: string }[] = [
  { value: 'RECOUNT', label: 'Count', help: 'The number you counted replaces the stock on hand and marks it as counted.', quantityLabel: 'Counted quantity' },
  { value: 'ADJUSTMENT', label: 'Add or remove', help: 'Adds or removes units (use − to remove), e.g. a delivery or a correction.', quantityLabel: 'Change (+/−)' },
  { value: 'DAMAGE_WRITE_OFF', label: 'Write off damaged', help: 'Removes damaged or unsellable units.', quantityLabel: 'Units to write off' },
];

/** The API's adjustment rules (shared schema), with the variant id filled in by the dialog. */
const adjustForm = z.object({ kind: z.enum(ADJUSTMENT_KINDS), quantity: z.number({ error: 'Enter a quantity' }), note: z.string() }).superRefine((v, ctx) => {
  const r = adjustmentRow.safeParse({ ...v, variantId: 1, note: v.note.trim() || undefined });
  if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: i.path, message: i.message });
});
type AdjustIn = z.input<typeof adjustForm>;

function AdjustDialog({ row, onClose }: { row: StockRow; onClose: () => void }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, control, setError: setFieldError, formState: { errors, isSubmitting } } = useForm<AdjustIn>({
    resolver: zodResolver(adjustForm), defaultValues: { kind: 'RECOUNT', quantity: undefined as unknown as number, note: '' },
  });
  const [kind, quantity] = useWatch({ control, name: ['kind', 'quantity'] });
  const k = KINDS.find((x) => x.value === kind)!;
  const q = Number.isFinite(quantity) ? Number(quantity) : null;
  const next = q === null ? null : kind === 'RECOUNT' ? q : kind === 'ADJUSTMENT' ? row.onHand + q : row.onHand - Math.abs(q);
  const submit = async (v: AdjustIn) => {
    setError(null);
    try {
      const res = await api.request<{ oversold: number[] }>('POST', '/admin/inventory/adjustments', { body: { rows: [{ variantId: row.variantId, kind: v.kind, quantity: v.quantity, ...(v.note.trim() ? { note: v.note.trim() } : {}) }] } });
      toast[res.oversold.length ? 'warning' : 'success'](res.oversold.length ? `${row.sku} is now oversold: an exception was raised for the team` : `${row.sku} updated`);
      await qc.invalidateQueries({ queryKey: ['inventory'] });
      await qc.invalidateQueries({ queryKey: ['products'] });
      onClose();
    } catch (e) {
      if (!applyServerErrors(e, (n, err) => setFieldError(n.replace(/^rows\.0\./, '') as keyof AdjustIn, err), ['rows.0.quantity', 'rows.0.note', 'rows.0.kind'] as never[])) setError(errorMessage(e));
    }
  };
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`Change stock: ${row.sku}`} description={`${row.product.name} · ${row.label}. On hand ${row.onHand}, reserved ${row.reserved}.`}>
      <form noValidate className="space-y-4" onSubmit={(e) => { void handleSubmit(submit)(e); }}>
        <fieldset>
          <legend className="text-sm font-medium text-ink-900">What happened</legend>
          <div className="mt-1 space-y-1">
            {KINDS.map((x) => <label key={x.value} className="flex items-center gap-2 text-sm text-ink-900"><input type="radio" value={x.value} {...register('kind')} className="h-4 w-4 accent-brand-700" />{x.label}</label>)}
          </div>
          <p className="mt-1 text-sm text-ink-700">{k.help}</p>
        </fieldset>
        <TextField id="adjust-quantity" label={k.quantityLabel} inputMode="numeric" {...register('quantity', { setValueAs: (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)) })} error={errors.quantity?.message} />
        <TextField id="adjust-note" label={kind === 'RECOUNT' ? 'Note (optional)' : 'Reason'} {...register('note')} error={errors.note?.message} />
        {next !== null && !errors.quantity && (
          <p className={`text-sm ${next < 0 ? 'text-danger-700' : next < row.reserved ? 'text-warning-700' : 'text-ink-700'}`} role="status">
            On hand {row.onHand} → {next}{next < 0 ? ' (not possible)' : next < row.reserved ? `: below the ${row.reserved} units reserved by open orders, so the item will be oversold` : ''}
          </p>
        )}
        {error && <FormAlert>{error}</FormAlert>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className={`${btn} text-ink-900 hover:bg-surface-100`} onClick={onClose}>Cancel</button>
          <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined} className={`${btn} bg-brand-700 text-white disabled:opacity-80`}>{isSubmitting ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </FormDialog>
  );
}

function HistoryDrawer({ row, onClose }: { row: StockRow; onClose: () => void }) {
  const { api } = useAuth();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['inventory', 'movements', row.variantId, page], queryFn: () => api.request<Page<Movement>>('GET', `/admin/inventory/${row.variantId}/movements`, { query: { page, limit: 50 } }), placeholderData: (p) => p });
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(100vw,760px)] flex-col bg-white shadow-xl outline-none" aria-describedby={undefined}>
          <header className="flex items-center justify-between border-b border-surface-200 px-5 py-4">
            <Dialog.Title className="text-lg font-semibold text-ink-900">Stock history: {row.sku}</Dialog.Title>
            <Dialog.Close className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-surface-100" aria-label="Close"><X aria-hidden size={20} /></Dialog.Close>
          </header>
          <div className="flex-1 overflow-auto p-5">
            {q.isError && <FormAlert>{errorMessage(q.error)}</FormAlert>}
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Stock movements</caption>
              <thead className="bg-surface-100 text-ink-700"><tr>{['When', 'What', 'On hand', 'Reserved', 'After', 'By', 'Note'].map((h) => <th key={h} scope="col" className="px-2 py-2 font-semibold">{h}</th>)}</tr></thead>
              <tbody>
                {q.data?.data.length === 0 && <tr><td colSpan={7} className="px-2 py-6 text-center text-ink-700">No stock movements yet.</td></tr>}
                {q.data?.data.map((m) => (
                  <tr key={m.id} className="border-t border-surface-200 align-top">
                    <td className="whitespace-nowrap px-2 py-2 text-ink-700">{dateTime.format(new Date(m.createdAt))}</td>
                    <td className="px-2 py-2 text-ink-900">{REASON[m.reason] ?? m.reason}{m.orderNumber && <span className="text-ink-700"> · order {m.orderNumber}</span>}{m.importId !== null && <> · <Link to={`/imports/${m.importId}`} className="text-brand-700 underline">import {m.importId}</Link></>}</td>
                    <td className="px-2 py-2 tabular-nums">{m.onHandDelta ? sign(m.onHandDelta) : '—'}</td>
                    <td className="px-2 py-2 tabular-nums">{m.reservedDelta ? sign(m.reservedDelta) : '—'}</td>
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums">{m.onHandAfter} / {m.reservedAfter}</td>
                    <td className="px-2 py-2 text-ink-700">{m.actor ?? (m.orderNumber ? 'Checkout' : 'System')}</td>
                    <td className="px-2 py-2 text-ink-700">{m.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {q.data && q.data.meta.totalPages > 1 && (
              <nav className="mt-3 flex items-center justify-between text-sm" aria-label="Pagination">
                <button type="button" className="h-11 rounded-md px-3 font-medium disabled:text-ink-500" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Newer</button>
                <span className="text-ink-700">Page {page} of {q.data.meta.totalPages}</span>
                <button type="button" className="h-11 rounded-md px-3 font-medium disabled:text-ink-500" disabled={page >= q.data.meta.totalPages} onClick={() => setPage(page + 1)}>Older ›</button>
              </nav>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function InventoryPage() {
  const { api, state } = useAuth();
  const perms = state.status === 'authenticated' ? state.permissions : [];
  const canAdjust = perms.includes('inventory:adjust');
  const params = useTableParams({ sort: 'default', filterKeys: ['q', 'stock'] });
  const [adjusting, setAdjusting] = useState<StockRow | null>(null);
  const [history, setHistory] = useState<StockRow | null>(null);
  const query = useQuery({
    queryKey: ['inventory', params.page, params.filters],
    queryFn: () => api.request<Page<StockRow>>('GET', '/admin/inventory', { query: { page: params.page, limit: 50, ...params.filters } }),
    placeholderData: (p) => p,
  });
  const sheet = async () => { try { saveBlob(await api.download('/admin/inventory/count-sheet.xlsx'), 'artq-stock-count.xlsx'); } catch (e) { toast.error(errorMessage(e)); } };

  const columns: ColumnDef<StockRow, unknown>[] = [
    { id: 'sku', header: 'SKU', cell: ({ row }) => <span className="font-mono text-xs">{row.original.sku}</span>, meta: { className: 'whitespace-nowrap' } },
    { id: 'product', header: 'Product', cell: ({ row }) => (
      <div><Link to={`/products/${row.original.product.id}`} className="font-medium text-ink-900 hover:underline">{row.original.product.name}</Link><p className="text-xs text-ink-700">{row.original.label}{!row.original.isActive && ' · inactive'}</p></div>
    ) },
    { id: 'onHand', header: 'On hand', cell: ({ row }) => <span className="tabular-nums">{row.original.onHand}</span> },
    { id: 'reserved', header: 'Reserved', cell: ({ row }) => <span className="tabular-nums text-ink-700">{row.original.reserved}</span> },
    { id: 'available', header: 'Available', cell: ({ row }) => {
      const r = row.original;
      if (r.onHand < r.reserved) return <span className="inline-flex items-center gap-2"><span className="font-semibold tabular-nums text-danger-700">{r.available}</span><span className={`${pill} bg-[#fee2e2] text-danger-700`}>Oversold</span></span>;
      return <span className={`tabular-nums ${r.available <= 0 ? 'font-semibold text-danger-700' : r.available <= r.lowStockThreshold ? 'font-semibold text-warning-700' : 'text-ink-900'}`}>{r.available}{r.available > 0 && r.available <= r.lowStockThreshold && <span className="sr-only"> (low)</span>}</span>;
    } },
    { id: 'counted', header: 'Counted', cell: ({ row }) => (row.original.countedAt ? <span className="whitespace-nowrap text-ink-700">{dateTime.format(new Date(row.original.countedAt))}</span> : <span className={`${pill} bg-warning-bg text-warning-ink`}>Not counted</span>) },
    { id: 'actions', header: () => <span className="sr-only">Actions</span>, cell: ({ row }) => (
      <div className="flex justify-end gap-1">
        {canAdjust && <button type="button" className="h-11 rounded-md px-3 font-medium text-brand-700 hover:bg-surface-100" onClick={() => setAdjusting(row.original)} aria-label={`Change stock of ${row.original.sku}`}>Change stock</button>}
        <button type="button" className="h-11 rounded-md px-3 font-medium text-ink-900 hover:bg-surface-100" onClick={() => setHistory(row.original)} aria-label={`Stock history of ${row.original.sku}`}>History</button>
      </div>
    ) },
  ];

  return (
    <>
      <PageHeader title="Inventory">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${btn} border border-border-input text-ink-900 hover:bg-surface-100`} onClick={() => void sheet()}><Download aria-hidden size={16} className="mr-2" />Download count sheet</button>
          {canAdjust && <Link to="/imports?kind=INVENTORY" className={`${btn} bg-brand-700 text-white`}><Upload aria-hidden size={16} className="mr-2" />Import counts</Link>}
        </div>
      </PageHeader>
      <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Show">
        {FILTERS.map(([v, l]) => {
          const on = (params.filters.stock ?? '') === v;
          return <button key={v} type="button" aria-pressed={on} onClick={() => params.setFilter('stock', v || null)} className={`h-10 rounded-md px-3 text-sm font-medium ${on ? 'bg-brand-700 text-white' : 'text-ink-900 hover:bg-surface-100'}`}>{l}</button>;
        })}
      </div>
      <form className="mb-4" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="text-sm text-ink-900">Search SKU or product
          <input className="mt-1 block h-11 w-72 rounded-md border border-border-input px-3" defaultValue={params.filters.q ?? ''} key={params.filters.q ?? ''}
            onBlur={(e) => params.setFilter('q', e.target.value.trim() || null)} onKeyDown={(e) => { if (e.key === 'Enter') params.setFilter('q', (e.target as HTMLInputElement).value.trim() || null); }} />
        </label>
      </form>
      <DataTable caption="Stock" columns={columns} query={query} params={params} getRowId={(r) => String(r.variantId)} emptyMessage="No variants match." />
      {adjusting && <AdjustDialog row={adjusting} onClose={() => setAdjusting(null)} />}
      {history && <HistoryDrawer row={history} onClose={() => setHistory(null)} />}
    </>
  );
}
