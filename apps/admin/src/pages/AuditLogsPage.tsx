// Audit Logs (task 2.1 list; task 6.5 detail and export; product.md §7 "Audit Logs") [audit:read, Super Admin].
// Filters on the shared rule (auditFilters: India days, "to" not before "from"); a click on an entry opens what
// changed, field by field, with who, when, from where and in which session; the CSV export (the filtered entries, up to
// AUDIT_EXPORT_MAX) asks for the password first because it holds IP addresses.
import { AUDIT_EXPORT_MAX, auditFilters, diffAudit, type AuditDetail, type AuditRow } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { X } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { Page } from '../api/client';
import { saveBlob } from '../api/upload';
import { useAuth } from '../auth/AuthProvider';
import { DataTable, useTableParams, type ColumnMeta } from '../components/DataTable';
import { btn } from '../components/dialogs';
import { errorMessage } from '../components/feedback';
import { FormAlert, SelectField, TextField } from '../components/form';
import { convertedForm } from '../components/form-schema';
import { PageHeader } from './simple';

export type { AuditRow };
const FILTER_KEYS = ['action', 'entity', 'entityId', 'actorId', 'from', 'to'] as const;
const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' });
const outline = `${btn} border border-border-input bg-white`;
const who = (a: AuditRow['actor']) => (a ? (a.name ?? a.email ?? `User #${a.id}`) : 'System');
const show = (v: unknown) => (v === undefined ? '(not set)' : v === null ? '(empty)' : typeof v === 'string' ? v : JSON.stringify(v));

type FilterForm = { action: string; entity: string; entityId: string; from: string; to: string };
/** The shared rule, with the form's empty boxes left out (an empty box means "any"). */
const filterForm = convertedForm<FilterForm, typeof auditFilters>(() => [], (v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x.trim() !== '')), auditFilters);

function Filters({ params, entities }: { params: ReturnType<typeof useTableParams>; entities: string[] }) {
  const f = params.filters;
  const form = useForm<FilterForm, unknown, ReturnType<typeof filterForm.parse>>({
    resolver: zodResolver(filterForm),
    defaultValues: { action: f.action ?? '', entity: f.entity ?? '', entityId: f.entityId ?? '', from: f.from ?? '', to: f.to ?? '' },
  });
  const e = form.formState.errors;
  const apply = form.handleSubmit((v) => { for (const k of ['action', 'entity', 'entityId', 'from', 'to'] as const) params.setFilter(k, v[k] ? String(v[k]) : null); });
  return (
    <form role="search" aria-label="Filter audit entries" noValidate onSubmit={(ev) => { void apply(ev); }} className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
      <TextField id="au-action" label="Action starts with" placeholder="order." {...form.register('action')} error={e.action?.message} />
      <SelectField id="au-entity" label="Record type" {...form.register('entity')} error={e.entity?.message}>
        <option value="">All</option>
        {entities.map((x) => <option key={x} value={x}>{x}</option>)}
      </SelectField>
      <TextField id="au-id" label="Record id" {...form.register('entityId')} error={e.entityId?.message} />
      <TextField id="au-from" label="From (India date)" type="date" {...form.register('from')} error={e.from?.message} />
      <TextField id="au-to" label="To" type="date" {...form.register('to')} error={e.to?.message} />
      <div className="flex gap-2">
        <button type="submit" className={outline}>Apply</button>
        {params.hasFilters && <button type="button" className={`${btn} text-ink-900 hover:bg-surface-100`} onClick={() => { form.reset({ action: '', entity: '', entityId: '', from: '', to: '' }); params.clearFilters(); }}>Clear</button>}
      </div>
    </form>
  );
}

function EntryDrawer({ id, onClose, onActor }: { id: string; onClose: () => void; onActor: (actorId: number) => void }) {
  const { api } = useAuth();
  const q = useQuery({ queryKey: ['audit-log', id], queryFn: () => api.request<AuditDetail>('GET', `/admin/audit-logs/${id}`) });
  const d = q.data;
  const changes = d ? diffAudit(d.before, d.after) : [];
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(100vw,760px)] flex-col bg-white shadow-xl outline-none" aria-describedby={undefined}>
          <header className="flex items-center justify-between border-b border-surface-200 px-5 py-4">
            <Dialog.Title className="text-lg font-semibold text-ink-900">Audit entry #{id}</Dialog.Title>
            <Dialog.Close className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-surface-100" aria-label="Close"><X aria-hidden size={20} /></Dialog.Close>
          </header>
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {q.isPending && <p role="status" className="text-ink-700">Loading…</p>}
            {q.isError && <FormAlert>{errorMessage(q.error)}</FormAlert>}
            {d && (
              <>
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
                  <dt className="text-ink-700">Action</dt><dd><code>{d.action}</code></dd>
                  <dt className="text-ink-700">Record</dt><dd>{d.entity}{d.entityId ? ` #${d.entityId}` : ''}</dd>
                  <dt className="text-ink-700">When</dt><dd>{dateTime.format(new Date(d.createdAt))}</dd>
                  <dt className="text-ink-700">Who</dt>
                  <dd>{who(d.actor)}{d.actor?.email && d.actor.name ? ` (${d.actor.email})` : ''}
                    {d.actor && <button type="button" className="ml-2 text-brand-700 underline underline-offset-2" onClick={() => onActor(d.actor!.id)}>All by this person</button>}</dd>
                  <dt className="text-ink-700">IP address</dt><dd>{d.ip ?? '—'}</dd>
                  <dt className="text-ink-700">Browser</dt><dd className="break-all">{d.userAgent ?? '—'}</dd>
                  <dt className="text-ink-700">Session</dt><dd className="break-all font-mono text-xs">{d.sessionId ?? '—'}</dd>
                </dl>
                <section aria-labelledby="au-changes">
                  <h3 id="au-changes" className="mb-2 font-semibold text-ink-900">What changed</h3>
                  {d.before === null && d.after === null ? <p className="text-sm text-ink-700">This entry records an event; nothing was changed.</p>
                    : changes.length === 0 ? <p className="text-sm text-ink-700">Saved without changes.</p>
                    : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <caption className="sr-only">Fields before and after</caption>
                          <thead className="bg-surface-100"><tr><th scope="col" className="px-3 py-2">Field</th><th scope="col" className="px-3 py-2">Before</th><th scope="col" className="px-3 py-2">After</th></tr></thead>
                          <tbody>
                            {changes.map((c) => (
                              <tr key={c.path} className="border-t border-surface-200 align-top">
                                <th scope="row" className="px-3 py-2 font-mono text-xs font-normal">{c.path}</th>
                                <td className="whitespace-pre-wrap break-all px-3 py-2 text-danger-700"><span className="sr-only">Before: </span>{show(c.before)}</td>
                                <td className="whitespace-pre-wrap break-all px-3 py-2 text-success-700"><span className="sr-only">After: </span>{show(c.after)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                </section>
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium text-ink-900">Full record</summary>
                  <pre className="mt-2 overflow-x-auto rounded-md bg-surface-100 p-3 text-xs">{JSON.stringify({ before: d.before, after: d.after }, null, 2)}</pre>
                </details>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AuditLogsPage() {
  const { api } = useAuth();
  const params = useTableParams({ sort: '-createdAt', filterKeys: [...FILTER_KEYS] });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const entities = useQuery({ queryKey: ['audit-entities'], queryFn: () => api.request<{ data: string[] }>('GET', '/admin/audit-logs/entities') });
  const query = useQuery({
    queryKey: ['audit-logs', params.page, params.sort, params.filters],
    queryFn: () => api.request<Page<AuditRow>>('GET', '/admin/audit-logs', { query: { page: params.page, limit: 25, sort: params.sort, ...params.filters } }),
    placeholderData: (prev) => prev,
  });
  const exportCsv = async () => {
    setBusy(true);
    try {
      const search = new URLSearchParams(params.filters).toString();
      saveBlob(await api.download(`/admin/audit-logs/export.csv${search ? `?${search}` : ''}`), `artq-audit-${new Date().toISOString().slice(0, 10)}.csv`);
      toast.success('Export downloaded');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const columns: ColumnDef<AuditRow, unknown>[] = [
    { id: 'createdAt', header: 'When', cell: ({ row }) => dateTime.format(new Date(row.original.createdAt)), meta: { sortKey: 'createdAt', className: 'whitespace-nowrap' } satisfies ColumnMeta },
    { id: 'actor', header: 'Who', cell: ({ row }) => who(row.original.actor) },
    { id: 'action', header: 'Action', cell: ({ row }) => <button type="button" className="text-left text-brand-700 underline underline-offset-2" aria-label={`Open entry ${row.original.id}: ${row.original.action}`} onClick={() => setOpen(row.original.id)}><code className="text-xs">{row.original.action}</code></button> },
    { id: 'entity', header: 'Record', cell: ({ row }) => `${row.original.entity}${row.original.entityId ? ` #${row.original.entityId}` : ''}` },
    // ink-500 is for white backgrounds only (design-system.md §2); table headers sit on surface-100, so muted cells use ink-700.
    { id: 'ip', header: 'IP', cell: ({ row }) => <span className="text-ink-700">{row.original.ip ?? '—'}</span> },
  ];
  const total = query.data?.meta.total ?? 0;
  return (
    <>
      <PageHeader title="Audit Logs">
        <button type="button" className={outline} disabled={busy || total === 0} onClick={() => void exportCsv()}>{busy ? 'Preparing…' : 'Export CSV'}</button>
      </PageHeader>
      <Filters key={JSON.stringify(params.filters)} params={params} entities={entities.data?.data ?? []} />
      {params.filters.actorId && <p className="mb-3 text-sm text-ink-700">Showing one person’s actions. <button type="button" className="text-brand-700 underline underline-offset-2" onClick={() => params.setFilter('actorId', null)}>Show everyone</button></p>}
      {total > AUDIT_EXPORT_MAX && <p className="mb-3 text-sm text-ink-700">The export holds the newest {AUDIT_EXPORT_MAX.toLocaleString('en-IN')} of these {total.toLocaleString('en-IN')} entries; narrow the dates for the rest.</p>}
      <DataTable caption="Audit log entries" columns={columns} query={query} params={params} getRowId={(r) => r.id} emptyMessage={params.hasFilters ? 'No audit entries match.' : 'No audit entries yet.'} />
      {open && <EntryDrawer id={open} onClose={() => setOpen(null)} onActor={(a) => { setOpen(null); params.setFilter('actorId', String(a)); }} />}
    </>
  );
}
