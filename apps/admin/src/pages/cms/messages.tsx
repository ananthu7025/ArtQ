// Messages inbox (task 6.1; product.md §7.5 "contact & custom-work inbox with private attachments"). What still needs
// someone by default, filterable by kind and status, searchable; a message opens with its details and photos (5-minute
// private links), and staff set its status and a note (the shared messagePatchBody).
import { MESSAGE_STATUSES, messagePatchBody, type AdminMessageDetail, type AdminMessageRow } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import type { Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, SelectField } from '../../components/form';
import { when } from '../orders/labels';
import { primary, quiet } from './parts';

const STATUS: Record<(typeof MESSAGE_STATUSES)[number], [string, string]> = {
  NEW: ['New', 'bg-warning-bg text-warning-ink'], IN_PROGRESS: ['In progress', 'bg-[#e0f2fe] text-[#075985]'], REPLIED: ['Replied', 'bg-[#dcfce7] text-success-700'], CLOSED: ['Closed', 'bg-surface-100 text-ink-700'],
};
const KIND: Record<string, string> = { CONTACT: 'Contact', CUSTOM_WORK: 'Custom work' };
const select = 'mt-1 block h-11 w-48 rounded-md border border-border-input bg-white px-3';

export function MessagesTab() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'newest', filterKeys: ['kind', 'status', 'q'] });
  const [text, setText] = useState(params.filters.q ?? '');
  const [open, setOpen] = useState<number | null>(null);
  const status = params.filters.status;
  const query = useQuery({
    queryKey: ['messages', params.page, params.filters],
    queryFn: () => api.request<Page<AdminMessageRow>>('GET', '/admin/messages', { query: { page: params.page, limit: 25, ...(params.filters.kind ? { kind: params.filters.kind } : {}), ...(params.filters.q ? { q: params.filters.q } : {}), ...(status === 'all' ? {} : status ? { status } : { open: '1' }) } }),
    placeholderData: (p) => p,
  });
  const columns: ColumnDef<AdminMessageRow, unknown>[] = [
    { id: 'from', header: 'From', cell: ({ row: { original: m } }) => <div><button type="button" className="font-medium text-brand-700 underline-offset-2 hover:underline" onClick={() => setOpen(m.id)}>{m.name}</button><div className="text-sm text-ink-700">{m.email}{m.phone ? ` · ${m.phone}` : ''}</div></div> },
    { id: 'msg', header: 'Message', cell: ({ row: { original: m } }) => <div className="max-w-md"><div className="text-sm font-medium text-ink-900">{KIND[m.kind]}{m.subject ? `: ${m.subject}` : ''}{m.orderNumber ? ` · ${m.orderNumber}` : ''}</div><div className="line-clamp-2 text-sm text-ink-700">{m.preview}</div>{m.attachments > 0 && <div className="text-xs text-ink-700">{m.attachments} photo{m.attachments === 1 ? '' : 's'}</div>}</div> },
    { id: 'status', header: 'Status', cell: ({ row: { original: m } }) => <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS[m.status][1]}`}>{STATUS[m.status][0]}</span> },
    { id: 'when', header: 'Received', cell: ({ row: { original: m } }) => <span className="text-sm">{when(m.createdAt)}</span> },
  ];
  return (
    <section aria-labelledby="msg-h" className="space-y-3">
      <h2 id="msg-h" className="text-lg font-semibold text-ink-900">Messages</h2>
      <form role="search" className="flex flex-wrap items-end gap-3 text-sm" onSubmit={(e) => { e.preventDefault(); params.setFilter('q', text.trim() || null); }}>
        <div><label htmlFor="msg-q">Search</label><input id="msg-q" type="search" maxLength={100} className="mt-1 block h-11 w-64 rounded-md border border-border-input bg-white px-3" placeholder="Name, email, subject or order" value={text} onChange={(e) => setText(e.target.value)} /></div>
        <div><label htmlFor="msg-kind">Kind</label>
          <select id="msg-kind" className={select} value={params.filters.kind ?? ''} onChange={(e) => params.setFilter('kind', e.target.value || null)}><option value="">Any</option><option value="CONTACT">Contact</option><option value="CUSTOM_WORK">Custom work</option></select></div>
        <div><label htmlFor="msg-status">Status</label>
          <select id="msg-status" className={select} value={status ?? ''} onChange={(e) => params.setFilter('status', e.target.value || null)}>
            <option value="">Not closed</option><option value="all">All</option>{MESSAGE_STATUSES.map((s) => <option key={s} value={s}>{STATUS[s][0]}</option>)}
          </select></div>
        <button type="submit" className={`${quiet} border border-border-input bg-white`}>Search</button>
      </form>
      <DataTable caption="Messages" columns={columns} query={query} params={params} getRowId={(m) => String(m.id)} emptyMessage={params.hasFilters ? 'No message matches.' : 'No open messages.'} />
      {open !== null && <MessageDialog id={open} onClose={() => setOpen(null)} onChanged={() => void query.refetch()} />}
    </section>
  );
}

function MessageDialog({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { api } = useAuth();
  const q = useQuery({ queryKey: ['message', id], queryFn: () => api.request<AdminMessageDetail>('GET', `/admin/messages/${id}`) });
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) onClose(); }} title={q.data ? `${KIND[q.data.kind]} from ${q.data.name}` : 'Message'}>
      {q.isPending ? <p role="status" className="text-ink-700">Loading…</p> : q.isError ? <FormAlert>{errorMessage(q.error)}</FormAlert> : <MessageView m={q.data} onSaved={() => { onChanged(); void q.refetch(); }} />}
    </FormDialog>
  );
}

function MessageView({ m, onSaved }: { m: AdminMessageDetail; onSaved: () => void }) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const form = useForm<z.input<typeof messagePatchBody>, unknown, z.output<typeof messagePatchBody>>({ resolver: zodResolver(messagePatchBody), defaultValues: { status: m.status, adminNote: m.adminNote ?? '' } });
  const err = form.formState.errors.adminNote?.message;
  const save = form.handleSubmit(async (body) => {
    setProblem(null);
    try { await api.request('PATCH', `/admin/messages/${m.id}`, { body }); toast.success('Message updated'); onSaved(); }
    catch (e) { if (!applyServerErrors(e, form.setError, ['status', 'adminNote'])) setProblem(errorMessage(e)); }
  });
  return (
    <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1 text-sm">
      <p className="text-ink-700">{m.email}{m.phone ? ` · ${m.phone}` : ''} · {when(m.createdAt)}{m.orderNumber ? ` · order ${m.orderNumber}` : ''}</p>
      {m.subject && <p className="font-medium text-ink-900">{m.subject}</p>}
      <p className="whitespace-pre-wrap text-ink-900">{m.message}</p>
      {m.details && <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">{Object.entries(m.details).map(([k, v]) => <div key={k} className="contents"><dt className="capitalize text-ink-700">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt><dd>{String(v ?? '—')}</dd></div>)}</dl>}
      {m.files.length > 0 && <ul className="flex flex-wrap gap-2">{m.files.map((f, n) => <li key={f.id}><a href={f.url} target="_blank" rel="noreferrer"><img src={f.thumbUrl ?? f.url} alt={`Attachment ${n + 1}`} className="h-20 w-20 rounded-md object-cover" /></a></li>)}</ul>}
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-3 border-t border-surface-200 pt-3">
        <SelectField id="msg-st" label="Status" {...form.register('status')} error={form.formState.errors.status?.message}>{MESSAGE_STATUSES.map((s) => <option key={s} value={s}>{STATUS[s][0]}</option>)}</SelectField>
        <div>
          <label htmlFor="msg-note" className="block font-medium text-ink-900">Staff note</label>
          <textarea id="msg-note" rows={3} className="mt-1 block w-full rounded-md border border-border-input p-2" aria-invalid={err ? true : undefined} aria-describedby={err ? 'msg-note-error' : undefined} {...form.register('adminNote')} />
          {err && <p id="msg-note-error" className="mt-1 text-danger-700">{err}</p>}
        </div>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end"><button type="submit" className={primary} disabled={form.formState.isSubmitting}>Save</button></div>
      </form>
    </div>
  );
}
