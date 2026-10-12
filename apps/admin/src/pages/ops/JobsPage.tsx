// Jobs & Webhooks (task 5.8; product.md §7.5, architecture.md §13 and §15) [jobs:read; retries jobs:retry]. What needs
// attention first (the same alerts the staff emails come from), then the health of each moving part: background queues
// (depths, failed jobs with Retry), Razorpay notifications (status counts, the failed and dead ones with Retry),
// background tasks by consumer (pending, published but not finished, stuck, dead with Retry), the search queue and the
// last run of each scheduled job. Retrying only puts work back in line; the consumers never do anything twice.
import { OPS_WEBHOOK_STATUSES, type OpsFailedJob, type OpsOutboxRow, type OpsSummary, type OpsWebhookRow } from '@artq/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { btn } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { FormAlert } from '../../components/form';
import { when } from '../orders/labels';
import { PageHeader } from '../simple';

const outline = `${btn} h-9 border border-border-input bg-white px-3 text-sm`;
const card = 'rounded-lg border border-surface-200 bg-white p-5';
const SEVERITY: Record<string, string> = { P1: 'border-danger-700 bg-[#fee2e2] text-danger-700', P2: 'border-[#f59e0b] bg-warning-bg text-warning-ink', P3: 'border-surface-200 bg-surface-100 text-ink-900' };
const ago = (iso: string | null) => (iso ? when(iso) : 'never');

function Section({ title, id, children, aside }: { title: string; id: string; children: ReactNode; aside?: ReactNode }) {
  return <section aria-labelledby={id} className={card}><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 id={id} className="font-semibold text-ink-900">{title}</h2>{aside}</div>{children}</section>;
}

export function JobsPage() {
  const { api, can } = useAuth();
  const canRetry = can('jobs:retry');
  const summary = useQuery({ queryKey: ['ops-summary'], queryFn: () => api.request<OpsSummary>('GET', '/admin/ops/summary'), refetchInterval: 30_000 });
  const [hookStatus, setHookStatus] = useState<string>('DEAD');
  const hooks = useQuery({ queryKey: ['ops-webhooks', hookStatus], queryFn: () => api.request<Page<OpsWebhookRow>>('GET', '/admin/ops/webhooks', { query: { status: hookStatus, limit: 25 } }) });
  const [outboxStatus, setOutboxStatus] = useState<string>('STUCK');
  const outbox = useQuery({ queryKey: ['ops-outbox', outboxStatus], queryFn: () => api.request<Page<OpsOutboxRow>>('GET', '/admin/ops/outbox-deliveries', { query: { status: outboxStatus, limit: 25 } }) });
  const failed = useQuery({ queryKey: ['ops-failed'], queryFn: () => api.request<{ data: OpsFailedJob[] }>('GET', '/admin/ops/jobs/failed'), retry: false });
  const refresh = () => { void summary.refetch(); void hooks.refetch(); void outbox.refetch(); void failed.refetch(); };
  const retry = async (path: string, done: string) => {
    try { await api.request('POST', path, { body: {} }); toast.success(done); } catch (e) { toast.error(errorMessage(e)); }
    refresh();
  };
  const s = summary.data;
  const select = 'h-9 rounded-md border border-border-input bg-white px-2 text-sm';
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><PageHeader title="Jobs & Webhooks" /><button type="button" className={outline} onClick={refresh}>Refresh</button></div>
      {summary.isError && <FormAlert>Couldn’t load the summary. {errorMessage(summary.error)}</FormAlert>}
      {s && (
        <section aria-labelledby="alerts-h" className="space-y-2">
          <h2 id="alerts-h" className="font-semibold text-ink-900">Needs attention</h2>
          {s.alerts.length === 0 ? <p className="text-sm text-success-700">All clear: nothing is stuck or failing.</p> : (
            <ul className="space-y-2">{s.alerts.map((a) => <li key={a.key} className={`rounded-md border px-4 py-3 text-sm ${SEVERITY[a.severity]}`}><span className="font-semibold">{a.severity} · {a.title}</span><span className="block">{a.detail}</span></li>)}</ul>
          )}
        </section>
      )}
      {s && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Section title="Queues" id="queues-h">
            {s.queues === null ? <p className="text-sm text-danger-700">The queues can’t be read (Redis unavailable).</p> : (
              <div className="overflow-x-auto"><table className="w-full text-sm"><caption className="sr-only">Queue depths</caption>
                <thead><tr className="text-left text-ink-700"><th scope="col" className="py-1 font-medium">Queue</th><th scope="col" className="py-1 text-right font-medium">Waiting</th><th scope="col" className="py-1 text-right font-medium">Active</th><th scope="col" className="py-1 text-right font-medium">Delayed</th><th scope="col" className="py-1 text-right font-medium">Failed</th></tr></thead>
                <tbody>{s.queues.map((q) => <tr key={q.name} className="border-t border-surface-100"><td className="py-1 font-mono text-xs">{q.name}</td><td className="py-1 text-right tabular-nums">{q.waiting}</td><td className="py-1 text-right tabular-nums">{q.active}</td><td className="py-1 text-right tabular-nums">{q.delayed}</td><td className={`py-1 text-right tabular-nums ${q.failed ? 'font-semibold text-danger-700' : ''}`}>{q.failed}</td></tr>)}</tbody>
              </table></div>
            )}
          </Section>
          <Section title="Scheduled jobs" id="sched-h">
            <ul className="space-y-1 text-sm">{s.schedulers.map((j) => <li key={j.name} className="flex flex-wrap justify-between gap-2"><span className="font-mono text-xs">{j.name}</span><span className={j.ok === false ? 'text-danger-700' : 'text-ink-700'} title={j.result ?? undefined}>{j.ok === false ? 'failed · ' : ''}{ago(j.lastRunAt)}</span></li>)}</ul>
            <p className="mt-3 text-sm text-ink-700">Search queue: {s.searchQueue.depth} waiting{s.searchQueue.oldestMinutes !== null ? `, oldest ${s.searchQueue.oldestMinutes} min` : ''} · Open exceptions: {s.exceptions.open}</p>
          </Section>
        </div>
      )}

      <Section title="Razorpay notifications" id="hooks-h" aside={s && <span className="text-sm text-ink-700">{OPS_WEBHOOK_STATUSES.map((k) => `${k.toLowerCase()} ${s.webhooks[k] ?? 0}`).join(' · ')}</span>}>
        <label htmlFor="hook-status" className="mr-2 text-sm">Show</label>
        <select id="hook-status" className={select} value={hookStatus} onChange={(e) => setHookStatus(e.target.value)}>{OPS_WEBHOOK_STATUSES.map((k) => <option key={k} value={k}>{k.toLowerCase()}</option>)}</select>
        <Rows empty="None." loading={hooks.isPending} rows={hooks.data?.data ?? []} render={(w) => (
          <li key={w.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
            <span><span className="font-medium">{w.eventType}</span> <span className="font-mono text-xs text-ink-700">{w.eventId}</span><span className="block text-ink-700">{when(w.receivedAt)} · {w.attempts} attempt(s){w.lastError ? ` · ${w.lastError}` : ''}</span></span>
            {canRetry && ['FAILED', 'DEAD'].includes(w.status) && <button type="button" className={outline} aria-label={`Retry notification ${w.eventId}`} onClick={() => void retry(`/admin/ops/webhooks/${w.id}/retry`, 'Notification queued again')}>Retry</button>}
          </li>
        )} />
      </Section>

      <Section title="Background tasks" id="outbox-h">
        {s && s.outbox.length > 0 && (
          <div className="mb-3 overflow-x-auto"><table className="w-full text-sm"><caption className="sr-only">Background tasks by consumer</caption>
            <thead><tr className="text-left text-ink-700"><th scope="col" className="py-1 font-medium">Consumer</th><th scope="col" className="py-1 text-right font-medium">Pending</th><th scope="col" className="py-1 text-right font-medium">Running</th><th scope="col" className="py-1 text-right font-medium">Stuck</th><th scope="col" className="py-1 text-right font-medium">Dead</th></tr></thead>
            <tbody>{s.outbox.map((c) => <tr key={c.consumer} className="border-t border-surface-100"><td className="py-1 font-mono text-xs">{c.consumer}</td><td className="py-1 text-right tabular-nums">{c.pending}</td><td className="py-1 text-right tabular-nums">{c.leased + c.published}</td><td className={`py-1 text-right tabular-nums ${c.stuck ? 'font-semibold text-warning-ink' : ''}`}>{c.stuck}</td><td className={`py-1 text-right tabular-nums ${c.dead ? 'font-semibold text-danger-700' : ''}`}>{c.dead}</td></tr>)}</tbody>
          </table></div>
        )}
        <label htmlFor="outbox-status" className="mr-2 text-sm">Show</label>
        <select id="outbox-status" className={select} value={outboxStatus} onChange={(e) => setOutboxStatus(e.target.value)}>
          <option value="STUCK">stuck</option><option value="DEAD">dead</option><option value="PENDING">pending</option><option value="PUBLISHED">published</option>
        </select>
        <Rows empty="None." loading={outbox.isPending} rows={outbox.data?.data ?? []} render={(d) => (
          <li key={d.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
            <span><span className="font-mono text-xs">{d.consumer}</span> · {d.eventType} · {d.aggregate}<span className="block text-ink-700">{d.status.toLowerCase()} · try {d.generation} · {when(d.createdAt)}{d.lastError ? ` · ${d.lastError}` : ''}</span></span>
            {canRetry && d.status === 'DEAD' && <button type="button" className={outline} aria-label={`Retry task ${d.id}`} onClick={() => void retry(`/admin/ops/outbox-deliveries/${d.id}/retry`, 'Task queued again')}>Retry</button>}
          </li>
        )} />
      </Section>

      <Section title="Failed jobs" id="failed-h">
        {failed.isError ? <p className="text-sm text-danger-700">{errorMessage(failed.error)}</p> : (
          <Rows empty="No failed jobs." loading={failed.isPending} rows={failed.data?.data ?? []} render={(j) => (
            <li key={`${j.queue}:${j.id}`} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
              <span><span className="font-mono text-xs">{j.queue}</span> · {j.name}<span className="block text-ink-700">{j.failedAt ? when(j.failedAt) : ''} · {j.attemptsMade} attempt(s){j.failedReason ? ` · ${j.failedReason}` : ''}</span></span>
              {canRetry && <button type="button" className={outline} aria-label={`Retry job ${j.name} ${j.id}`} onClick={() => void retry(`/admin/ops/jobs/${encodeURIComponent(j.queue)}/${encodeURIComponent(j.id)}/retry`, 'Job queued again')}>Retry</button>}
            </li>
          )} />
        )}
      </Section>
      {!canRetry && <p className="text-sm text-ink-700">Retrying needs the Super Admin role.</p>}
    </div>
  );
}

function Rows<T>({ rows, render, empty, loading }: { rows: T[]; render: (r: T) => ReactNode; empty: string; loading: boolean }) {
  if (loading) return <p role="status" className="mt-2 text-sm text-ink-700">Loading…</p>;
  if (rows.length === 0) return <p className="mt-2 text-sm text-ink-700">{empty}</p>;
  return <ul className="mt-2 divide-y divide-surface-100">{rows.map(render)}</ul>;
}
