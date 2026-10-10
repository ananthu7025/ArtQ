// Staff & Permissions (product.md §7 "Staff & Permissions", api.md §4.10) [staff:manage, SUPER_ADMIN only].
// Changes ask for the password again (the API answers 401 STEP_UP_REQUIRED and the client opens the step-up dialog).
import { PERMISSION_LABEL, PERMISSIONS, ROLE_PERMISSIONS, staffCreateBody, type StaffCreate, type StaffRole } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { Page } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { DataTable, useTableParams } from '../components/DataTable';
import { btn, ConfirmDialog, FormDialog } from '../components/dialogs';
import { useFeedbackMutation } from '../components/feedback';
import { applyServerErrors, FormAlert, SelectField, TextField } from '../components/form';
import { PageHeader } from './simple';

export type StaffRow = {
  id: number; name: string | null; email: string; role: StaffRole; status: 'ACTIVE' | 'BLOCKED' | 'PENDING_VERIFICATION';
  passwordSet: boolean; lastLoginAt: string | null; createdAt: string; activeSessions: number;
};

export const ROLES: { value: StaffRole; label: string; help: string }[] = [
  { value: 'STAFF', label: 'Staff', help: 'Orders, packing, shipping and stock counts. Cannot change prices or refund.' },
  { value: 'ADMIN', label: 'Admin', help: 'Everything Staff can do, plus products, prices, refunds and returns.' },
  { value: 'SUPER_ADMIN', label: 'Super Admin', help: 'Full access, including staff, settings and audit logs.' },
];
const roleLabel = (r: StaffRole) => ROLES.find((x) => x.value === r)?.label ?? r;
const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const pill = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold';

function StatusPill({ row }: { row: StaffRow }) {
  if (row.status === 'BLOCKED') return <span className={`${pill} bg-[#fee2e2] text-danger-700`}>Blocked</span>;
  if (!row.passwordSet) return <span className={`${pill} bg-warning-bg text-warning-ink`}>Invite pending</span>;
  return <span className={`${pill} bg-[#dcfce7] text-success-700`}>Active</span>;
}

function AddStaffDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { api } = useAuth();
  const [error, setError] = useState<string | null>(null);
  // The same schema the API validates with (CLAUDE.md "Validation rule").
  const { register, handleSubmit, control, reset, setError: setFieldError, formState: { errors } } = useForm({ resolver: zodResolver(staffCreateBody), defaultValues: { role: 'STAFF' as StaffRole } });
  const add = useFeedbackMutation<StaffCreate, StaffRow>({
    mutationFn: (v) => api.request('POST', '/admin/staff', { body: v }),
    success: (r) => `Invite sent to ${r.email}`,
    onError: (e) => { if (!applyServerErrors(e, setFieldError, ['name', 'email', 'role'])) setError(e instanceof Error ? e.message : 'Something went wrong'); },
    invalidate: [['staff']],
  });
  const close = (o: boolean) => { if (!o) { reset(); setError(null); } onOpenChange(o); };
  const role = useWatch({ control, name: 'role' });
  return (
    <FormDialog open={open} onOpenChange={close} title="Add staff" description="They get an email with a link to choose their password. The link works once and expires in 72 hours.">
      <form className="space-y-4" noValidate onSubmit={handleSubmit((v) => { setError(null); add.mutate(v, { onSuccess: () => close(false) }); })}>
        <TextField id="staff-name" label="Name" autoComplete="off" {...register('name')} error={errors.name?.message} />
        <TextField id="staff-email" label="Email" type="email" autoComplete="off" {...register('email')} error={errors.email?.message} />
        <SelectField id="staff-role" label="Role" {...register('role')} error={errors.role?.message} hint={ROLES.find((r) => r.value === role)?.help}>
          {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </SelectField>
        {error && <FormAlert>{error}</FormAlert>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className={`${btn} text-ink-900 hover:bg-surface-100`} onClick={() => close(false)}>Cancel</button>
          <button type="submit" disabled={add.isPending} aria-busy={add.isPending || undefined} className={`${btn} bg-brand-700 text-white disabled:opacity-80`}>{add.isPending ? 'Sending invite…' : 'Send invite'}</button>
        </div>
      </form>
    </FormDialog>
  );
}

type Confirm = { title: string; description: string; label: string; danger?: boolean; run: () => void };

function ManageStaffDialog({ row, onClose }: { row: StaffRow; onClose: () => void }) {
  const { api } = useAuth();
  const [role, setRole] = useState<StaffRole>(row.role);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const who = row.name ?? row.email;
  const opts = <V,>(success: string, path: string, method: 'POST' | 'PATCH' = 'POST') => ({
    mutationFn: (body: V) => api.request<StaffRow | undefined>(method, `/admin/staff/${row.id}${path}`, { body }),
    success, invalidate: [['staff']],
  });
  const changeRole = useFeedbackMutation<{ role: StaffRole | 'CUSTOMER' }>(opts(`${who}'s role was updated. They need to log in again.`, '', 'PATCH'));
  const remove = useFeedbackMutation<{ role: 'CUSTOMER' }>(opts(`${who} no longer has admin access.`, '', 'PATCH'));
  const block = useFeedbackMutation<object>(opts(`${who} is blocked and was logged out everywhere.`, '/block'));
  const unblock = useFeedbackMutation<object>(opts(`${who} can log in again.`, '/unblock'));
  const revoke = useFeedbackMutation<object>(opts(`${who} was logged out on every device.`, '/revoke-sessions'));
  const link = useFeedbackMutation<object>(opts(`A password link was emailed to ${row.email}.`, '/send-password-link'));
  const busy = [changeRole, remove, block, unblock, revoke, link].some((m) => m.isPending);
  const done = () => { setConfirm(null); onClose(); };
  const action = 'h-11 w-full rounded-md border border-surface-200 px-4 text-left font-medium text-ink-900 hover:bg-surface-100 disabled:opacity-60';

  return (
    <>
      <FormDialog open={confirm === null} onOpenChange={(o) => { if (!o) onClose(); }} title={`Manage ${who}`} description={row.email}>
        <div className="space-y-5">
          <div>
            <label htmlFor="manage-role" className="block text-sm font-medium text-ink-900">Role</label>
            <div className="mt-1 flex gap-2">
              <select id="manage-role" value={role} onChange={(e) => setRole(e.target.value as StaffRole)} aria-describedby="manage-role-help" className="h-11 flex-1 rounded-md border border-border-input bg-white px-3 text-ink-900">
                {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
              <button type="button" disabled={role === row.role || busy} className={`${btn} bg-brand-700 text-white disabled:opacity-60`}
                onClick={() => setConfirm({ title: `Make ${who} ${roleLabel(role)}?`, description: 'They will be logged out of the admin and need to log in again.', label: 'Change role', run: () => changeRole.mutate({ role }, { onSuccess: done }) })}>
                Save role
              </button>
            </div>
            <p id="manage-role-help" className="mt-1 text-sm text-ink-700">{ROLES.find((r) => r.value === role)?.help}</p>
          </div>
          <div className="space-y-2">
            {row.status === 'BLOCKED' ? (
              <button type="button" className={action} disabled={busy} onClick={() => unblock.mutate({}, { onSuccess: done })}>Unblock</button>
            ) : (
              <>
                <button type="button" className={action} disabled={busy} onClick={() => link.mutate({}, { onSuccess: done })}>{row.passwordSet ? 'Email a password reset link' : 'Resend the invite'}</button>
                <button type="button" className={action} disabled={busy || row.activeSessions === 0}
                  onClick={() => setConfirm({ title: `Log ${who} out everywhere?`, description: 'Every device they are logged in on will need to log in again. Their account stays active.', label: 'Log out everywhere', run: () => revoke.mutate({}, { onSuccess: done }) })}>
                  Log out everywhere{row.activeSessions ? ` (${row.activeSessions} active)` : ''}
                </button>
                <button type="button" className={`${action} text-danger-700`} disabled={busy}
                  onClick={() => setConfirm({ title: `Block ${who}?`, description: 'They are logged out everywhere and cannot log in until you unblock them.', label: 'Block', danger: true, run: () => block.mutate({}, { onSuccess: done }) })}>
                  Block
                </button>
              </>
            )}
            <button type="button" className={`${action} text-danger-700`} disabled={busy}
              onClick={() => setConfirm({ title: `Remove ${who}'s admin access?`, description: 'They are logged out of the admin. Their customer account and orders are kept; you can add them again later.', label: 'Remove access', danger: true, run: () => remove.mutate({ role: 'CUSTOMER' }, { onSuccess: done }) })}>
              Remove admin access
            </button>
          </div>
        </div>
      </FormDialog>
      {confirm && (
        <ConfirmDialog open onOpenChange={(o) => { if (!o) setConfirm(null); }} title={confirm.title} description={confirm.description} confirmLabel={confirm.label}
          {...(confirm.danger ? { danger: true } : {})} busy={busy} onConfirm={confirm.run} />
      )}
    </>
  );
}

export function StaffPage() {
  const { api, state } = useAuth();
  const myId = state.status === 'authenticated' ? state.user.id : null;
  const params = useTableParams({ sort: 'role', filterKeys: ['q', 'role', 'status'] });
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<StaffRow | null>(null);
  const query = useQuery({
    queryKey: ['staff', params.page, params.filters],
    queryFn: () => api.request<Page<StaffRow>>('GET', '/admin/staff', { query: { page: params.page, limit: 50, ...params.filters } }),
    placeholderData: (prev) => prev,
  });
  const columns: ColumnDef<StaffRow, unknown>[] = [
    { id: 'name', header: 'Name', cell: ({ row }) => (
      <div><div className="font-medium text-ink-900">{row.original.name ?? '—'}{row.original.id === myId && <span className="ml-2 text-xs font-normal text-ink-700">(you)</span>}</div>
        <div className="text-sm text-ink-700">{row.original.email}</div></div>
    ) },
    { id: 'role', header: 'Role', cell: ({ row }) => roleLabel(row.original.role) },
    { id: 'status', header: 'Status', cell: ({ row }) => <StatusPill row={row.original} /> },
    { id: 'lastLoginAt', header: 'Last login', cell: ({ row }) => (row.original.lastLoginAt ? dateTime.format(new Date(row.original.lastLoginAt)) : <span className="text-ink-700">Never</span>), meta: { className: 'whitespace-nowrap' } },
    { id: 'actions', header: () => <span className="sr-only">Actions</span>, cell: ({ row }) => (row.original.id === myId
      ? <span className="text-sm text-ink-700">Ask another Super Admin to change your access</span>
      : <button type="button" className="h-11 rounded-md border border-border-input px-4 font-medium text-ink-900 hover:bg-surface-100" onClick={() => setManaging(row.original)} aria-label={`Manage ${row.original.name ?? row.original.email}`}>Manage</button>) },
  ];
  return (
    <>
      <PageHeader title="Staff & Permissions">
        <button type="button" onClick={() => setAdding(true)} className={`${btn} bg-brand-700 text-white`}>Add staff</button>
      </PageHeader>
      <form className="mb-4 flex flex-wrap items-end gap-3" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="text-sm text-ink-900">Search name or email
          <input className="mt-1 block h-11 w-64 rounded-md border border-border-input px-3" defaultValue={params.filters.q ?? ''} key={params.filters.q ?? ''}
            onBlur={(e) => params.setFilter('q', e.target.value.trim() || null)} onKeyDown={(e) => { if (e.key === 'Enter') params.setFilter('q', (e.target as HTMLInputElement).value.trim() || null); }} />
        </label>
        <label className="text-sm text-ink-900">Role
          <select className="mt-1 block h-11 w-44 rounded-md border border-border-input bg-white px-3" value={params.filters.role ?? ''} onChange={(e) => params.setFilter('role', e.target.value || null)}>
            <option value="">All roles</option>
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
        <label className="text-sm text-ink-900">Status
          <select className="mt-1 block h-11 w-40 rounded-md border border-border-input bg-white px-3" value={params.filters.status ?? ''} onChange={(e) => params.setFilter('status', e.target.value || null)}>
            <option value="">Any status</option>
            <option value="ACTIVE">Active</option>
            <option value="BLOCKED">Blocked</option>
          </select>
        </label>
      </form>
      <DataTable caption="Staff members" columns={columns} query={query} params={params} getRowId={(r) => String(r.id)} emptyMessage="No staff match." skeletonRows={4} />
      <AddStaffDialog open={adding} onOpenChange={setAdding} />
      {managing && <ManageStaffDialog key={managing.id} row={managing} onClose={() => setManaging(null)} />}
      <RoleMatrix />
    </>
  );
}

/** What each role can do (task 6.5), straight from the permissions the API enforces. */
function RoleMatrix() {
  return (
    <details className="mt-8 rounded-lg border border-surface-200 bg-white">
      <summary className="cursor-pointer px-5 py-4 font-semibold text-ink-900">What each role can do</summary>
      <div className="overflow-x-auto px-5 pb-5">
        <table className="w-full min-w-[560px] text-left text-sm">
          <caption className="sr-only">Permissions by role</caption>
          <thead className="bg-surface-100">
            <tr><th scope="col" className="px-3 py-2">Can</th>{ROLES.map((r) => <th key={r.value} scope="col" className="px-3 py-2 text-center">{r.label}</th>)}</tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p} className="border-t border-surface-200">
                <th scope="row" className="px-3 py-2 font-normal text-ink-900">{PERMISSION_LABEL[p]}</th>
                {ROLES.map((r) => {
                  const yes = ROLE_PERMISSIONS[r.value].includes(p);
                  return <td key={r.value} className="px-3 py-2 text-center">{yes ? <span aria-label="Yes" className="font-semibold text-success-700">✓</span> : <span aria-label="No" className="text-ink-700">–</span>}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
