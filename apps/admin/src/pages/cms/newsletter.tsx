// Newsletter subscribers (task 6.3) [content:write]: counts, search, status filter, Unsubscribe on request, and the CSV
// of current subscribers (each with their unsubscribe link, for a campaign tool) after a password re-check.
import type { NewsletterRow, NewsletterSummary } from '@artq/shared';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Page } from '../../api/client';
import { saveBlob } from '../../api/upload';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { ConfirmDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { when } from '../orders/labels';
import { outline, small } from './parts';

export function NewsletterTab() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'newest', filterKeys: ['status', 'q'] });
  const [text, setText] = useState(params.filters.q ?? '');
  const [removing, setRemoving] = useState<NewsletterRow | null>(null);
  const [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ['newsletter', params.page, params.filters], queryFn: () => api.request<Page<NewsletterRow> & { summary: NewsletterSummary }>('GET', '/admin/newsletter', { query: { page: params.page, limit: 50, ...params.filters } }), placeholderData: (p) => p });
  const exportCsv = async () => {
    setBusy(true);
    try { saveBlob(await api.download('/admin/newsletter/export.csv'), `artq-newsletter-${new Date().toISOString().slice(0, 10)}.csv`); toast.success('Export downloaded'); }
    catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const unsubscribe = async (r: NewsletterRow) => {
    try { await api.request('POST', `/admin/newsletter/${r.id}/unsubscribe`); toast.success(`${r.email} unsubscribed`); } catch (e) { toast.error(errorMessage(e)); }
    setRemoving(null); void query.refetch();
  };
  const s = query.data?.summary;
  const columns: ColumnDef<NewsletterRow, unknown>[] = [
    { id: 'email', header: 'Email', cell: ({ row: { original: r } }) => <span className="font-medium text-ink-900">{r.email}</span> },
    { id: 'source', header: 'Signed up from', cell: ({ row: { original: r } }) => <span className="text-sm">{r.source}</span> },
    { id: 'when', header: 'Since', cell: ({ row: { original: r } }) => <div className="text-sm">{when(r.createdAt)}{r.unsubscribedAt && <div className="text-ink-700">Unsubscribed {when(r.unsubscribedAt)}</div>}</div> },
    { id: 'action', header: 'Action', cell: ({ row: { original: r } }) => (r.status === 'SUBSCRIBED'
      ? <button type="button" className={`${small} text-danger-700 hover:bg-[#fee2e2]`} aria-label={`Unsubscribe ${r.email}`} onClick={() => setRemoving(r)}>Unsubscribe</button>
      : <span className="text-sm text-ink-700">Unsubscribed</span>) },
  ];
  return (
    <section aria-labelledby="news-h" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 id="news-h" className="text-lg font-semibold text-ink-900">Newsletter</h2>
          <p className="text-sm text-ink-700">{s ? `${s.subscribed.toLocaleString('en-IN')} subscribed · ${s.unsubscribed.toLocaleString('en-IN')} unsubscribed.` : ' '} Every email you send them must include their unsubscribe link (it is in the export).</p></div>
        <button type="button" className={outline} disabled={busy} onClick={() => void exportCsv()}>{busy ? 'Preparing…' : 'Export subscribers (CSV)'}</button>
      </div>
      <form role="search" className="flex flex-wrap items-end gap-3 text-sm" onSubmit={(e) => { e.preventDefault(); params.setFilter('q', text.trim() || null); }}>
        <div><label htmlFor="news-q">Search email</label><input id="news-q" type="search" maxLength={100} className="mt-1 block h-11 w-64 rounded-md border border-border-input bg-white px-3" value={text} onChange={(e) => setText(e.target.value)} /></div>
        <div><label htmlFor="news-status">Status</label>
          <select id="news-status" className="mt-1 block h-11 w-48 rounded-md border border-border-input bg-white px-3" value={params.filters.status ?? ''} onChange={(e) => params.setFilter('status', e.target.value || null)}>
            <option value="">Any</option><option value="SUBSCRIBED">Subscribed</option><option value="UNSUBSCRIBED">Unsubscribed</option>
          </select></div>
        <button type="submit" className={outline}>Search</button>
      </form>
      <DataTable caption="Newsletter subscribers" columns={columns} query={query} params={params} getRowId={(r) => String(r.id)} emptyMessage={params.hasFilters ? 'No subscriber matches.' : 'No subscribers yet.'} />
      <ConfirmDialog open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null); }} title="Unsubscribe this address?" description={removing ? `${removing.email} won’t be in future exports. Use this when they ask you to stop.` : ''}
        confirmLabel="Unsubscribe" danger onConfirm={() => { if (removing) void unsubscribe(removing); }} />
    </section>
  );
}
