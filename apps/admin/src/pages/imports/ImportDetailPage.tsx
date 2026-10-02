// One import (task 2.7): preview after the check, confirm, progress while importing, results with per-row outcome,
// flags and messages, and Apply / Skip for rows that changed in the admin since the check (NEEDS_REVIEW).
import { formatINR } from '@artq/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { Page } from '../../api/client';
import { saveBlob } from '../../api/upload';
import { useAuth } from '../../auth/AuthProvider';
import { btn, ConfirmDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { FormAlert } from '../../components/form';
import { PageHeader } from '../simple';
import { FLAG_LABEL, ImportStatus, OUTCOME, PLAN, type ImportRowView, type ImportView } from './parts';

const RUNNING = ['UPLOADED', 'VALIDATING', 'IMPORTING'];
const TABS: { key: string; label: string; query: Record<string, string> }[] = [
  { key: 'all', label: 'All rows', query: {} }, { key: 'flagged', label: 'With flags', query: { flagged: '1' } },
  { key: 'NEEDS_REVIEW', label: 'Needs review', query: { status: 'NEEDS_REVIEW' } }, { key: 'FAILED', label: 'Failed', query: { status: 'FAILED' } },
  { key: 'CREATED', label: 'Created', query: { status: 'CREATED' } }, { key: 'UPDATED', label: 'Updated', query: { status: 'UPDATED' } },
];

export function ImportDetailPage() {
  const { api } = useAuth();
  const qc = useQueryClient();
  const id = Number(useParams().id);
  const [tab, setTab] = useState('all');
  const [page, setPage] = useState(1);
  const [confirming, setConfirming] = useState<'confirm' | 'cancel' | null>(null);
  const [busy, setBusy] = useState(false);
  const imp = useQuery({
    queryKey: ['import', id], enabled: Number.isInteger(id) && id > 0,
    queryFn: () => api.request<ImportView>('GET', `/admin/imports/${id}`),
    refetchInterval: (q) => (q.state.data && RUNNING.includes(q.state.data.status) ? 2000 : false),
  });
  const status = imp.data?.status;
  // When an import finishes, the catalogue lists elsewhere in the app are out of date.
  useEffect(() => {
    if (status === 'COMPLETED' || status === 'COMPLETED_WITH_ERRORS') {
      for (const key of ['products', 'product-types', 'categories', 'techniques', 'taxonomy']) void qc.invalidateQueries({ queryKey: [key] });
    }
  }, [status, qc]);
  const rows = useQuery({
    queryKey: ['import-rows', id, tab, page, status, imp.data?.rows],
    enabled: !!status && !['UPLOADED', 'VALIDATING', 'FAILED'].includes(status),   // a failed check stored no rows
    queryFn: () => api.request<Page<ImportRowView>>('GET', `/admin/imports/${id}/rows`, { query: { ...TABS.find((t) => t.key === tab)!.query, page, limit: 50 } }),
    placeholderData: (p) => p,
  });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['import', id] }); await qc.invalidateQueries({ queryKey: ['import-rows', id] }); await qc.invalidateQueries({ queryKey: ['imports'] }); };
  const act = async (what: 'confirm' | 'cancel') => {
    setBusy(true);
    try {
      await api.request('POST', `/admin/imports/${id}/${what}`, { body: {} });
      toast.success(what === 'confirm' ? 'Import started' : 'Import cancelled');
      await refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); setConfirming(null); }
  };
  const resolve = async (row: ImportRowView, action: 'apply' | 'skip') => {
    try {
      await api.request('POST', `/admin/imports/${id}/rows/${row.id}/resolve`, { body: { action } });
      toast.success(action === 'apply' ? `Row ${row.rowNumber} applied` : `Row ${row.rowNumber} skipped`);
      await refresh();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const download = async () => {
    try { saveBlob(await api.download(`/admin/imports/${id}/result.xlsx`), `catalog-import-${id}-result.xlsx`); } catch (e) { toast.error(errorMessage(e)); }
  };

  if (imp.isError) return <><PageHeader title="Import" /><FormAlert>{errorMessage(imp.error)} <Link to="/imports" className="underline">All imports</Link></FormAlert></>;
  if (!imp.data) return <p className="text-ink-700" role="status">Loading the import…</p>;
  const i = imp.data;
  const counts = i.rows ?? {};
  const done = (counts.CREATED ?? 0) + (counts.UPDATED ?? 0) + (counts.UNCHANGED ?? 0) + (counts.SKIPPED ?? 0) + (counts.NEEDS_REVIEW ?? 0) + (counts.FAILED ?? 0);
  const percent = i.totalRows ? Math.round((done / i.totalRows) * 100) : 0;

  return (
    <>
      <PageHeader title={i.fileName}>
        <div className="flex flex-wrap items-center gap-2">
          <ImportStatus status={i.status} />
          {!['UPLOADED', 'VALIDATING', 'FAILED'].includes(i.status) && <button type="button" className={`${btn} border border-border-input text-ink-900 hover:bg-surface-100`} onClick={() => void download()}><Download aria-hidden size={16} className="mr-2" />Result file</button>}
          {['UPLOADED', 'VALIDATED', 'IMPORTING'].includes(i.status) && <button type="button" className={`${btn} text-danger-700 hover:bg-surface-100`} onClick={() => setConfirming('cancel')}>Cancel import</button>}
          {i.status === 'VALIDATED' && <button type="button" className={`${btn} bg-brand-700 text-white`} onClick={() => setConfirming('confirm')}>Import {i.totalRows} rows</button>}
        </div>
      </PageHeader>
      <Link to="/imports" className="mb-4 inline-block text-sm font-medium text-brand-700 underline">All imports</Link>

      <section aria-label="Summary" className="mb-4 rounded-lg border border-surface-200 bg-white p-5">
        {(i.status === 'UPLOADED' || i.status === 'VALIDATING') && <p role="status" className="text-ink-700">Checking the file. This page updates by itself.</p>}
        {i.status === 'FAILED' && <FormAlert>The file could not be imported. Check that it is the catalogue workbook (download the template to compare) and upload it again.</FormAlert>}
        {i.status !== 'UPLOADED' && i.status !== 'VALIDATING' && i.status !== 'FAILED' && (
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4 lg:grid-cols-7">
            {[['Rows', i.totalRows], ['Products', i.products ?? 0], ['With flags', i.flaggedRows ?? 0], ['Created', counts.CREATED ?? 0], ['Updated', (counts.UPDATED ?? 0) + (counts.UNCHANGED ?? 0)], ['Needs review', counts.NEEDS_REVIEW ?? 0], ['Failed', counts.FAILED ?? 0]].map(([label, n]) => (
              <div key={label}><dt className="text-ink-700">{label}</dt><dd className="text-2xl font-semibold tabular-nums text-ink-900">{n}</dd></div>
            ))}
          </dl>
        )}
        {i.status === 'VALIDATED' && <p className="mt-3 text-sm text-ink-700">Nothing has changed yet. Review the rows below, then import. Rows with flags are imported as drafts that list what to fix before publishing.</p>}
        {i.status === 'IMPORTING' && (
          <div className="mt-4" role="status">
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-200"><div className="h-2 bg-brand-700 transition-all" style={{ width: `${percent}%` }} /></div>
            <p className="mt-1 text-sm text-ink-700">{done} of {i.totalRows} rows ({percent} %)</p>
          </div>
        )}
      </section>

      {rows.data && (
        <>
          <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Show rows">
            {TABS.map((t) => <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => { setTab(t.key); setPage(1); }} className={`h-10 rounded-md px-3 text-sm font-medium ${tab === t.key ? 'bg-brand-700 text-white' : 'text-ink-900 hover:bg-surface-100'}`}>{t.label}</button>)}
          </div>
          <div className="overflow-x-auto rounded-lg border border-surface-200 bg-white">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Import rows</caption>
              <thead className="bg-surface-100 text-ink-700">
                <tr>{['Row', 'SKU', 'Product', 'Size', 'Price', 'Stock in sheet', 'Flags', 'Outcome', 'Notes'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.data.data.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-ink-700">No rows here.</td></tr>}
                {rows.data.data.map((r) => (
                  <tr key={r.id} className="border-t border-surface-200 align-top">
                    <td className="px-3 py-2 tabular-nums text-ink-700">{r.rowNumber}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{r.sku}</td>
                    <td className="px-3 py-2">{r.productId ? <Link to={`/products/${r.productId}`} className="text-brand-700 underline">{r.productName}</Link> : r.productName}</td>
                    <td className="whitespace-nowrap px-3 py-2">{r.size ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.price === null ? <span className="text-danger-700">None</span> : formatINR(r.price)}{r.mrp !== null && <span className="text-ink-700"> (MRP {formatINR(r.mrp)})</span>}</td>
                    <td className="px-3 py-2 tabular-nums">{String(r.stock)}</td>
                    <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{r.flags.map((f) => <span key={f} title={f} className="rounded-full bg-warning-bg px-2 py-0.5 text-xs text-warning-ink">{FLAG_LABEL[f] ?? f}</span>)}</div></td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={r.status === 'FAILED' ? 'font-semibold text-danger-700' : r.status === 'NEEDS_REVIEW' ? 'font-semibold text-warning-700' : 'text-ink-900'}>{r.status === 'PENDING' ? PLAN[r.plan] ?? OUTCOME.PENDING : OUTCOME[r.status] ?? r.status}</span>
                      {r.status === 'NEEDS_REVIEW' && (
                        <div className="mt-1 flex gap-1">
                          <button type="button" className="h-9 rounded-md bg-brand-700 px-3 text-xs font-medium text-white" onClick={() => void resolve(r, 'apply')} aria-label={`Apply row ${r.rowNumber}`}>Apply</button>
                          <button type="button" className="h-9 rounded-md border border-border-input px-3 text-xs font-medium text-ink-900" onClick={() => void resolve(r, 'skip')} aria-label={`Skip row ${r.rowNumber}`}>Skip</button>
                        </div>
                      )}
                    </td>
                    <td className="max-w-md px-3 py-2 text-xs text-ink-700">{r.messages.filter((m) => m.code !== 'SKU_GENERATED').map((m) => m.text).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="mt-3 flex items-center justify-between text-sm" aria-label="Pagination">
            <button type="button" className="h-11 rounded-md px-3 font-medium disabled:text-ink-500" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Previous</button>
            <span className="text-ink-700">Page {rows.data.meta.page} of {rows.data.meta.totalPages} · {rows.data.meta.total} rows</span>
            <button type="button" className="h-11 rounded-md px-3 font-medium disabled:text-ink-500" disabled={page >= rows.data.meta.totalPages} onClick={() => setPage(page + 1)}>Next ›</button>
          </nav>
        </>
      )}
      {confirming && (
        <ConfirmDialog open onOpenChange={(o) => { if (!o) setConfirming(null); }} busy={busy} onConfirm={() => void act(confirming)}
          title={confirming === 'confirm' ? `Import ${i.totalRows} rows?` : 'Cancel this import?'}
          description={confirming === 'confirm' ? 'New products are created as drafts and existing ones are updated. Stock and live/draft status are never changed by an import.' : 'Rows already imported stay; the rest are skipped.'}
          confirmLabel={confirming === 'confirm' ? 'Import' : 'Cancel import'} {...(confirming === 'cancel' ? { danger: true } : {})} />
      )}
    </>
  );
}
