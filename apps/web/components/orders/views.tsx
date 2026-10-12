'use client';
// Order pages (task 5.7; product.md §5.10): the account's orders, one order for its signed-in owner, and the guest page
// opened from the tracking link in the order emails. The guest sees the order read-only until they confirm the
// order's email with a one-time code; then (for an hour, this order only) they can cancel, report a problem and get
// the invoice.
import { formatINR, orderAccessRequestBody, orderAccessVerifyBody, type CustomerOrderSummary, type CustomerOrderView } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ApiError, clientRequest } from '../../lib/api';
import { AccountShell } from '../account/AccountView';
import { Loading, useRequireSignIn } from '../account/auth-shared';
import { applyServerErrors, FormAlert, primaryButton, secondaryButton, textLink, TextField } from '../form/fields';
import { useApi } from '../shop/ShopProvider';
import { OrderDetail, type Call } from './OrderDetail';

const date = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });
type Page<T> = { data: T[]; meta: { page: number; totalPages: number; total: number } };

export function OrdersListView() {
  const user = useRequireSignIn('/account/orders');
  const api = useApi();
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Page<CustomerOrderSummary> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!user) return;
    let live = true;
    api<Page<CustomerOrderSummary>>('GET', `/me/orders?page=${page}`).then((r) => { if (live) { setList(r); setFailed(false); } }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [api, user, page]);
  if (!user) return <Loading />;
  return (
    <AccountShell title="Your orders">
      {failed ? <FormAlert>We couldn’t load your orders. Please try again.</FormAlert>
        : !list ? <p role="status" className="text-ink-700">Loading your orders…</p>
        : list.data.length === 0 ? <p className="text-ink-700">You haven’t ordered yet. <Link href="/shop" className={textLink}>Browse the shop</Link>.</p>
        : (
          <>
            <ul className="divide-y divide-surface-200 rounded-lg border border-surface-200">
              {list.data.map((o) => (
                <li key={o.orderNumber}>
                  <Link href={`/account/orders/${o.orderNumber}`} className="flex items-center gap-4 p-4 hover:bg-surface-100">
                    {o.firstItem?.imageUrl ? <img src={o.firstItem.imageUrl} alt="" className="h-14 w-14 rounded-md object-cover" /> : <span className="h-14 w-14 rounded-md bg-surface-100" aria-hidden />}
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-ink-900"><span className="font-mono">{o.orderNumber}</span> · {o.displayStatus}</span>
                      <span className="block text-sm text-ink-700">{date.format(new Date(o.createdAt))} · {o.itemCount} item{o.itemCount === 1 ? '' : 's'}{o.firstItem ? ` · ${o.firstItem.name}` : ''}</span>
                    </span>
                    <span className="tabular-nums font-medium text-ink-900">{formatINR(o.total)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {list.meta.totalPages > 1 && (
              <nav aria-label="Pages" className="flex items-center justify-between gap-3">
                <button type="button" className={secondaryButton} disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</button>
                <span className="text-sm text-ink-700">Page {page} of {list.meta.totalPages}</span>
                <button type="button" className={secondaryButton} disabled={page >= list.meta.totalPages} onClick={() => setPage(page + 1)}>Older</button>
              </nav>
            )}
          </>
        )}
    </AccountShell>
  );
}

export function AccountOrderView({ orderNumber }: { orderNumber: string }) {
  const user = useRequireSignIn(`/account/orders/${orderNumber}`);
  const api = useApi();
  const [view, setView] = useState<CustomerOrderView | 'missing' | 'failed' | null>(null);
  const base = `/me/orders/${encodeURIComponent(orderNumber)}`;
  useEffect(() => {
    if (!user) return;
    let live = true;
    api<CustomerOrderView>('GET', base).then((v) => { if (live) setView(v); }).catch((e) => { if (live) setView(e instanceof ApiError && e.status === 404 ? 'missing' : 'failed'); });
    return () => { live = false; };
  }, [api, user, base]);
  if (!user || view === null) return <Loading label="Loading your order…" />;
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-8 md:px-6 md:py-12">
      <Link href="/account/orders" className={textLink}>← Your orders</Link>
      <div className="mt-4">
        {view === 'missing' ? <FormAlert>We couldn’t find this order in your account.</FormAlert>
          : view === 'failed' ? <FormAlert>We couldn’t load this order. Please try again.</FormAlert>
          : <OrderDetail view={view} base={base} call={api as Call} onChange={setView} />}
      </div>
    </div>
  );
}

/** The guest order page: read-only from the tracking link; actions after the email code. */
export function TrackOrderView({ orderNumber, token }: { orderNumber: string; token: string | null }) {
  const [view, setView] = useState<CustomerOrderView | 'invalid' | 'failed' | null>(null);
  const guest: Call = useCallback((method, path, body, headers) => clientRequest(method, path, body, fetch, headers), []);
  const base = `/orders/${encodeURIComponent(orderNumber)}`;
  useEffect(() => {
    let live = true;
    // Already verified within the hour (the order cookie)? Show the full order; else the tracking view.
    guest<CustomerOrderView>('GET', base)
      .catch(() => (token ? guest<CustomerOrderView>('GET', `/orders/track/${encodeURIComponent(orderNumber)}?token=${encodeURIComponent(token)}`) : Promise.reject(new ApiError(404, 'NOT_FOUND', ''))))
      .then((v) => { if (live) setView(v); })
      .catch((e) => { if (live) setView(e instanceof ApiError && (e.status === 404 || e.status === 400) ? 'invalid' : 'failed'); });
    return () => { live = false; };
  }, [guest, base, orderNumber, token]);
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-8 md:px-6 md:py-12">
      {view === null ? <p role="status" className="text-ink-700">Loading your order…</p>
        : view === 'invalid' ? (
          <div className="max-w-xl space-y-3">
            <h1 className="font-display text-[28px] font-semibold text-ink-900">We couldn’t open this order</h1>
            <p className="text-ink-700">The link may be incomplete or too old. Use the link in your latest order email, or <Link href="/login" className={textLink}>log in</Link> if the order is in your account.</p>
          </div>
        )
        : view === 'failed' ? <FormAlert>We couldn’t load this order. Please try again.</FormAlert>
        : <OrderDetail view={view} base={view.access === 'tracking' ? null : base} call={guest} onChange={setView}
            notice={view.access === 'tracking' ? <VerifyPanel orderNumber={orderNumber} call={guest} onVerified={setView} /> : null} />}
    </div>
  );
}

function VerifyPanel({ orderNumber, call, onVerified }: { orderNumber: string; call: Call; onVerified: (v: CustomerOrderView) => void }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ask = useForm<z.input<typeof orderAccessRequestBody>, unknown, z.output<typeof orderAccessRequestBody>>({ resolver: zodResolver(orderAccessRequestBody), defaultValues: { email: '' } });
  const check = useForm<z.input<typeof orderAccessVerifyBody>, unknown, z.output<typeof orderAccessVerifyBody>>({ resolver: zodResolver(orderAccessVerifyBody), defaultValues: { email: '', code: '' } });
  const n = encodeURIComponent(orderNumber);
  const send = ask.handleSubmit(async (b) => {
    setProblem(null);
    try { await call('POST', `/orders/${n}/access/request`, b); setSentTo(b.email); check.reset({ email: b.email, code: '' }); }
    catch (e) { if (!applyServerErrors(e, ask.setError, ['email'])) setProblem(e instanceof Error ? e.message : 'Please try again.'); }
  });
  const verify = check.handleSubmit(async (b) => {
    setProblem(null);
    try { onVerified(await call<CustomerOrderView>('POST', `/orders/${n}/access/verify`, b)); }
    catch (e) {
      if (e instanceof ApiError && ['OTP_INVALID', 'OTP_EXPIRED'].includes(e.code)) { check.setError('code', { message: e.message }); return; }
      if (!applyServerErrors(e, check.setError, ['email', 'code'])) setProblem(e instanceof Error ? e.message : 'Please try again.');
    }
  });
  return (
    <section aria-labelledby="verify-h" className="rounded-lg border border-surface-200 bg-surface-100 p-5">
      <h2 id="verify-h" className="text-lg font-semibold text-ink-900">Manage this order</h2>
      <p className="mt-1 text-sm text-ink-700">To cancel, report a problem or get the invoice, confirm the email you ordered with. We’ll send a one-time code; access lasts an hour.</p>
      {sentTo === null ? (
        <form noValidate onSubmit={(e) => { void send(e); }} className="mt-4 flex flex-wrap items-start gap-3">
          <TextField id="v-email" label="Email used for the order" type="email" autoComplete="email" className="min-w-[16rem] flex-1" {...ask.register('email')} error={ask.formState.errors.email?.message} />
          <button type="submit" className={`${primaryButton} mt-6`} disabled={ask.formState.isSubmitting}>{ask.formState.isSubmitting ? 'Sending…' : 'Send code'}</button>
        </form>
      ) : (
        <form noValidate onSubmit={(e) => { void verify(e); }} className="mt-4 space-y-3">
          <p className="text-sm text-ink-900" role="status">If {sentTo} is the email on this order, a 6-digit code is on its way. It works for 10 minutes.</p>
          <div className="flex flex-wrap items-start gap-3">
            <TextField id="v-code" label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="w-40" {...check.register('code')} error={check.formState.errors.code?.message} />
            <button type="submit" className={`${primaryButton} mt-6`} disabled={check.formState.isSubmitting}>{check.formState.isSubmitting ? 'Checking…' : 'Confirm'}</button>
            <button type="button" className={`${secondaryButton} mt-6`} onClick={() => setSentTo(null)}>Use another email</button>
          </div>
        </form>
      )}
      {problem && <div className="mt-3"><FormAlert>{problem}</FormAlert></div>}
    </section>
  );
}
