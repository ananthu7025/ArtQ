import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useAuth } from '../auth/AuthProvider';
import type { Page } from '../api/client';
import { DataTable, useTableParams, type ColumnMeta } from '../components/DataTable';
import { PageHeader } from './simple';

export type AuditRow = { id: string; createdAt: string; action: string; entity: string; entityId: string | null; actor: { id: number; email: string | null; name: string | null } | null; ip: string | null };

const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const columns: ColumnDef<AuditRow, unknown>[] = [
  { id: 'createdAt', header: 'When', cell: ({ row }) => dateTime.format(new Date(row.original.createdAt)), meta: { sortKey: 'createdAt', className: 'whitespace-nowrap' } satisfies ColumnMeta },
  { id: 'actor', header: 'Who', cell: ({ row }) => row.original.actor?.name ?? row.original.actor?.email ?? 'System' },
  { id: 'action', header: 'Action', cell: ({ row }) => <code className="text-xs">{row.original.action}</code> },
  { id: 'entity', header: 'Record', cell: ({ row }) => `${row.original.entity}${row.original.entityId ? ` #${row.original.entityId}` : ''}` },
  // ink-500 is for white backgrounds only (design-system.md §2); table headers sit on surface-100, so muted cells use ink-700.
  { id: 'ip', header: 'IP', cell: ({ row }) => <span className="text-ink-700">{row.original.ip ?? '—'}</span> },
];

export function AuditLogsPage() {
  const { api } = useAuth();
  const params = useTableParams({ sort: '-createdAt', filterKeys: ['action', 'entity'] });
  const query = useQuery({
    queryKey: ['audit-logs', params.page, params.sort, params.filters],
    queryFn: () => api.request<Page<AuditRow>>('GET', '/admin/audit-logs', { query: { page: params.page, limit: 25, sort: params.sort, ...params.filters } }),
    placeholderData: (prev) => prev,
  });
  return (
    <>
      <PageHeader title="Audit Logs" />
      <form className="mb-4 flex flex-wrap items-end gap-3" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="text-sm text-ink-900">Action starts with
          <input className="mt-1 block h-11 w-56 rounded-md border border-border-input px-3" defaultValue={params.filters.action ?? ''} key={params.filters.action ?? ''}
            onBlur={(e) => params.setFilter('action', e.target.value.trim() || null)} onKeyDown={(e) => { if (e.key === 'Enter') params.setFilter('action', (e.target as HTMLInputElement).value.trim() || null); }} />
        </label>
        <label className="text-sm text-ink-900">Record type
          <select className="mt-1 block h-11 w-44 rounded-md border border-border-input bg-white px-3" value={params.filters.entity ?? ''} onChange={(e) => params.setFilter('entity', e.target.value || null)}>
            <option value="">All</option>
            {['user', 'session', 'media', 'variant', 'request', 'order', 'refund'].map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </label>
      </form>
      <DataTable caption="Audit log entries" columns={columns} query={query} params={params} getRowId={(r) => r.id} emptyMessage="No audit entries match." />
    </>
  );
}
