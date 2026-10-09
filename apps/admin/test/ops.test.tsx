// Task 5.8 in the admin against a fake API. Payment Exceptions: what needs someone by default, filters asked of the
// server, each exception explained, Resolve / Dismiss with a required note (on its field), someone-else-closed-it
// handled, Reconcile for one order. Jobs & Webhooks: alerts first, queues, scheduled runs, notifications, background
// tasks and failed jobs; Retry only for super admins and only for failed / dead work.
import { permissionsFor, type AdminExceptionRow, type OpsSummary, type Role } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

const ex = (o: Partial<AdminExceptionRow> = {}): AdminExceptionRow => ({
  id: 5, type: 'REFUND_FAILED', status: 'OPEN', createdAt: '2026-10-09T06:00:00Z', ageMinutes: 95, amount: 50_000, order: { id: 7, orderNumber: 'AQ10234' }, refundId: 41, paymentId: 'pay_X',
  details: {}, resolution: null, resolvedAt: null, resolvedBy: null, ...o,
});
const page = <T,>(rows: T[]) => [200, { data: rows, meta: { page: 1, limit: 25, total: rows.length, totalPages: 1 } }] as [number, unknown];
const summary = (o: Partial<OpsSummary> = {}): OpsSummary => ({
  alerts: [{ key: 'webhooks-failing', severity: 'P1', title: 'Razorpay notifications are failing', detail: '2 notification(s) failed or gave up for more than 15 minutes.' }],
  queues: [{ name: 'email.customer', waiting: 3, active: 1, delayed: 0, failed: 2, completed: 40 }],
  webhooks: { PROCESSED: 120, DEAD: 2 }, outbox: [{ consumer: 'email.customer', pending: 1, leased: 0, published: 0, stuck: 1, dead: 1 }],
  searchQueue: { depth: 0, oldestMinutes: null }, exceptions: { open: 1, oldestMinutes: 95 },
  schedulers: [{ name: 'refunds-reconcile', lastRunAt: '2026-10-09T10:00:00Z', ok: true, result: '{}' }, { name: 'cod-overdue', lastRunAt: null, ok: null, result: null }], ...o,
});

function setup(path: string, extra: Record<string, Handler> = {}, role: Role = 'ADMIN') {
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 1, name: 'Anu', email: 'anu@artq.in', role } }],
    'GET /admin/me': () => [200, { user: { id: 1, name: 'Anu', email: 'anu@artq.in', role }, permissions: permissionsFor(role) }],
    'GET /admin/payment-exceptions': () => page([ex()]),
    'GET /admin/ops/summary': () => [200, summary()],
    'GET /admin/ops/webhooks': () => page([{ id: 9, provider: 'razorpay', eventId: 'evt_1', eventType: 'payment.captured', status: 'DEAD', attempts: 10, lastError: 'timeout', receivedAt: '2026-10-09T06:00:00Z', nextAttemptAt: '2026-10-09T06:00:00Z', processedAt: null }]),
    'GET /admin/ops/outbox-deliveries': () => page([{ id: 77, consumer: 'email.customer', eventType: 'order.placed', aggregate: 'order AQ10234', status: 'DEAD', generation: 10, lastError: 'smtp down', createdAt: '2026-10-09T06:00:00Z', publishedAt: null, nextAttemptAt: '2026-10-09T06:00:00Z' }]),
    'GET /admin/ops/jobs/failed': () => [200, { data: [{ queue: 'media.process', id: '12', name: 'media.process', failedReason: 'storage down', attemptsMade: 3, failedAt: '2026-10-09T06:00:00Z' }] }],
    ...extra,
  });
  window.history.replaceState({}, '', path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const sent = (s: ReturnType<typeof setup>['server'], method: string, path: string) => s.calls.filter((c) => c.method === method && c.path === path);

describe('payment exceptions', () => {
  it('needs-someone by default; explained in staff words; filters asked of the server; accessible', async () => {
    const u = userEvent.setup();
    const { server, container } = setup('/payment-exceptions');
    expect(await screen.findByText('Retry it from the order’s refunds, or refund by bank transfer.', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'AQ10234' }).getAttribute('href')).toBe('/orders/7');
    expect(screen.getByText('1 h ago')).toBeTruthy();
    expect(sent(server, 'GET', '/admin/payment-exceptions')[0]!.query.get('open')).toBe('1');
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
    await u.selectOptions(screen.getByLabelText('Type'), 'OVERSOLD');
    await waitFor(() => expect(sent(server, 'GET', '/admin/payment-exceptions').at(-1)!.query.get('type')).toBe('OVERSOLD'));
    await u.selectOptions(screen.getByLabelText('Status'), 'all');
    await waitFor(() => expect(sent(server, 'GET', '/admin/payment-exceptions').at(-1)!.query.get('open')).toBeNull());
  });

  it('resolve: a note is required (on its field); the note is sent; someone else closing it first is explained', async () => {
    const u = userEvent.setup();
    let reply: [number, unknown] = err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'resolution', message: 'Use at most 500 characters' }]);
    const { server } = setup('/payment-exceptions', { 'POST /admin/payment-exceptions/5/resolve': () => reply });
    await u.click(await screen.findByRole('button', { name: 'Resolve exception #5' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Resolve this exception' }));
    await u.click(dialog.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expectFieldError('What did you do?', 'Say what you did', dialog));
    expect(sent(server, 'POST', '/admin/payment-exceptions/5/resolve')).toHaveLength(0);
    await u.type(dialog.getByLabelText('What did you do?'), 'Refunded by UPI, ref 998');
    await u.click(dialog.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expectFieldError('What did you do?', 'Use at most 500 characters', dialog));
    reply = err(422, 'INVALID_TRANSITION', 'Someone has already closed this exception. Reload to see the latest.');
    await u.click(dialog.getByRole('button', { name: 'Resolve' }));
    expect(await screen.findByText('Someone has already closed this exception. Reload to see the latest.')).toBeTruthy();
    expect(sent(server, 'POST', '/admin/payment-exceptions/5/resolve').at(-1)!.body).toEqual({ resolution: 'Refunded by UPI, ref 998' });
  });

  it('dismiss and reconcile one order', async () => {
    const u = userEvent.setup();
    const { server } = setup('/payment-exceptions', {
      'POST /admin/payment-exceptions/5/dismiss': () => [200, ex({ status: 'DISMISSED' })],
      'GET /admin/orders': () => page([{ id: 7, orderNumber: 'AQ10234' }]),
      'POST /admin/payments/reconcile': () => [200, { applied: 1, refunds: {} }],
    });
    await u.click(await screen.findByRole('button', { name: 'Dismiss exception #5' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Dismiss this exception' }));
    await u.type(dialog.getByLabelText('Why does it need no action?'), 'Customer confirmed it arrived');
    await u.click(dialog.getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('Exception dismissed')).toBeTruthy();
    expect(sent(server, 'POST', '/admin/payment-exceptions/5/dismiss')[0]!.body).toEqual({ note: 'Customer confirmed it arrived' });
    await u.click(screen.getByRole('button', { name: 'Reconcile with Razorpay' }));
    const rc = within(await screen.findByRole('dialog', { name: 'Reconcile with Razorpay' }));
    await u.type(rc.getByLabelText('Order number (optional)'), 'aq10234');
    await u.click(rc.getByRole('button', { name: 'Reconcile' }));
    expect(await screen.findByText('Checked with Razorpay: 1 payment(s) applied')).toBeTruthy();
    expect(sent(server, 'POST', '/admin/payments/reconcile')[0]!.body).toEqual({ orderId: 7 });
  });
});

describe('jobs & webhooks', () => {
  it('alerts first, then queues, scheduled runs, notifications, tasks and failed jobs; admins cannot retry', async () => {
    const { container } = setup('/jobs');
    expect(await screen.findByText('P1 · Razorpay notifications are failing')).toBeTruthy();
    const queues = within(screen.getByRole('table', { name: 'Queue depths' }));
    expect(queues.getByText('email.customer')).toBeTruthy();
    expect(screen.getByText('cod-overdue').parentElement!.textContent).toContain('never');
    expect(await screen.findByText('payment.captured')).toBeTruthy();
    expect(await screen.findByText(/storage down/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Retry/ })).toBeNull();
    expect(screen.getByText('Retrying needs the Super Admin role.')).toBeTruthy();
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
  });

  it('super admins retry a dead notification, a dead task and a failed job', async () => {
    const u = userEvent.setup();
    const { server } = setup('/jobs', {
      'POST /admin/ops/webhooks/9/retry': () => [200, { ok: true }],
      'POST /admin/ops/outbox-deliveries/77/retry': () => [200, { ok: true }],
      'POST /admin/ops/jobs/media.process/12/retry': () => err(422, 'INVALID_TRANSITION', 'Only a failed job can be retried.'),
    }, 'SUPER_ADMIN');
    await u.click(await screen.findByRole('button', { name: 'Retry notification evt_1' }));
    expect(await screen.findByText('Notification queued again')).toBeTruthy();
    await u.click(await screen.findByRole('button', { name: 'Retry task 77' }));
    expect(await screen.findByText('Task queued again')).toBeTruthy();
    await u.click(await screen.findByRole('button', { name: 'Retry job media.process 12' }));
    expect(await screen.findByText('Only a failed job can be retried.')).toBeTruthy();
    expect(sent(server, 'POST', '/admin/ops/webhooks/9/retry')).toHaveLength(1);
  });

  it('all clear when there are no alerts; the queues being unreadable is said plainly', async () => {
    setup('/jobs', { 'GET /admin/ops/summary': () => [200, summary({ alerts: [], queues: null })] });
    expect(await screen.findByText('All clear: nothing is stuck or failing.')).toBeTruthy();
    expect(screen.getByText('The queues can’t be read (Redis unavailable).')).toBeTruthy();
  });
});
