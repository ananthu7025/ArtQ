'use client';
// Placing an order and paying (product.md §5.6 "Payment behaviour", api.md §3.8, architecture.md §7.2–7.3):
//   initiate (Idempotency-Key; 202 PAYMENT_STARTING → the same key again after `retryAfter`) → COD: placed;
//   online: Razorpay → verify → PLACED | PROCESSING (poll the status every 3 s for up to 2 minutes) | REVIEW | REFUNDED.
//   Closed or failed in Razorpay → "Payment didn't go through" with Retry payment and Switch to COD (when allowed),
//   both through POST /orders/:n/payment/retry with a new key. The server decides every outcome; this only follows it.
import type { CheckoutStatus, InitiateResult, RazorpayCheckout, VerifyResult } from '@artq/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { payWithRazorpay, type RazorpayResult } from '../../lib/razorpay';
import { errorText, useApi, useShop } from '../shop/ShopProvider';

export type FlowState =
  | { step: 'idle' }
  | { step: 'placing' }
  | { step: 'paying'; orderNumber: string }
  | { step: 'verifying'; orderNumber: string }
  | { step: 'processing'; orderNumber: string; gaveUp: boolean }
  | { step: 'failed'; orderNumber: string; reason: string }
  | { step: 'review'; orderNumber: string }
  | { step: 'refunded'; orderNumber: string }
  | { step: 'expired'; orderNumber: string }
  | { step: 'placed'; orderNumber: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const POLL_MS = 3000;
export const POLL_FOR_MS = 120_000;

export type FlowDeps = {
  pay?: (r: RazorpayCheckout, orderNumber: string) => Promise<RazorpayResult>;
  newKey?: () => string;
  pollMs?: number;
  pollForMs?: number;
  /** Wait before repeating a request the server says is still in progress (its Retry-After). */
  inProgressMs?: number;
};

export function useCheckoutFlow(deps: FlowDeps = {}) {
  const api = useApi();
  const { reloadCart } = useShop();
  const [state, setState] = useState<FlowState>({ step: 'idle' });
  // Loops (payment starting, polling) stop when the page goes away.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const pay = deps.pay ?? payWithRazorpay;
  const pollMs = deps.pollMs ?? POLL_MS;
  const pollForMs = deps.pollForMs ?? POLL_FOR_MS;
  const inProgressMs = deps.inProgressMs ?? 2000;

  const placed = useCallback((orderNumber: string) => { reloadCart(); setState({ step: 'placed', orderNumber }); }, [reloadCart]);

  /** Polls the order while the bank confirms; up to 2 minutes, then "we'll email you". */
  const poll = useCallback(async (orderNumber: string) => {
    setState({ step: 'processing', orderNumber, gaveUp: false });
    const until = Date.now() + pollForMs;
    while (alive.current && Date.now() < until) {
      await sleep(pollMs);
      try {
        const s = await api<CheckoutStatus>('GET', `/checkout/status/${encodeURIComponent(orderNumber)}`);
        if (['PLACED', 'CONFIRMED', 'COMPLETED'].includes(s.status)) { placed(orderNumber); return; }
        if (s.status === 'EXPIRED' || s.status === 'CANCELLED') { setState({ step: 'expired', orderNumber }); return; }
      } catch { /* keep polling: the network may be back next time */ }
    }
    setState({ step: 'processing', orderNumber, gaveUp: true });
  }, [api, placed, pollMs, pollForMs]);

  /** Opens Razorpay for a pending order and follows the outcome. */
  const payOnline = useCallback(async (orderNumber: string, r: RazorpayCheckout | null) => {
    if (!r) { setState({ step: 'failed', orderNumber, reason: 'The payment couldn’t start.' }); return; }
    setState({ step: 'paying', orderNumber });
    let result: RazorpayResult;
    try { result = await pay(r, orderNumber); } catch { setState({ step: 'failed', orderNumber, reason: 'The payment window couldn’t open. Check your connection.' }); return; }
    if (result.kind !== 'paid') {
      // Informational only: the server never changes the order because of this.
      void api('POST', '/checkout/payment-failed', { orderNumber, razorpayPaymentId: result.kind === 'failed' ? result.paymentId : null, error: result.kind === 'failed' ? result.reason : 'DISMISSED' }).catch(() => {});
      setState({ step: 'failed', orderNumber, reason: result.kind === 'failed' ? result.reason : 'You closed the payment window.' });
      return;
    }
    setState({ step: 'verifying', orderNumber });
    try {
      const v = await api<VerifyResult>('POST', '/checkout/verify', { orderNumber, razorpayPaymentId: result.paymentId, razorpaySignature: result.signature });
      if (v.status === 'PLACED') placed(orderNumber);
      else if (v.status === 'PROCESSING') await poll(orderNumber);
      else if (v.status === 'REVIEW') { reloadCart(); setState({ step: 'review', orderNumber }); }
      else setState({ step: 'refunded', orderNumber });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PAYMENT_VERIFICATION_FAILED') setState({ step: 'failed', orderNumber, reason: 'We couldn’t confirm this payment.' });
      else await poll(orderNumber);   // network trouble after paying: the webhook still records the payment
    }
  }, [api, pay, placed, poll, reloadCart]);

  /** Follows an initiate/retry answer, repeating the request with the same key while the payment is starting. */
  const follow = useCallback(async (send: (key: string) => Promise<InitiateResult>) => {
    const key = (deps.newKey ?? (() => crypto.randomUUID()))();
    // The same key until there is an answer: 409 REQUEST_IN_PROGRESS means the first request is still running.
    const sendOnce = async (): Promise<InitiateResult> => {
      for (let i = 0; ; i++) {
        try { return await send(key); } catch (e) {
          if (!(e instanceof ApiError && e.code === 'REQUEST_IN_PROGRESS') || i >= 10 || !alive.current) throw e;
          await sleep(inProgressMs);
        }
      }
    };
    let r = await sendOnce();
    for (let i = 0; r.status === 'PAYMENT_STARTING' && i < 10 && alive.current; i++) { await sleep(Math.max(1, r.retryAfter) * 1000); r = await sendOnce(); }
    if (r.status === 'PLACED') { placed(r.orderNumber); return; }
    if (r.status === 'PAYMENT_STARTING') { await poll(r.orderNumber); return; }
    await payOnline(r.orderNumber, r.razorpay);
  }, [deps.newKey, inProgressMs, payOnline, placed, poll]);

  /** Place order; refusals (price changed, out of stock, validation) are thrown for the form to show. */
  const place = useCallback(async (body: unknown) => {
    setState({ step: 'placing' });
    try {
      await follow((key) => api<InitiateResult>('POST', '/checkout/initiate', body, { 'Idempotency-Key': key }));
    } catch (e) {
      setState({ step: 'idle' });
      throw e;
    }
  }, [api, follow]);

  /** Retry payment online, or switch the pending order to cash on delivery. */
  const retry = useCallback(async (orderNumber: string, paymentMethod: 'RAZORPAY' | 'COD') => {
    setState({ step: 'placing' });
    try {
      await follow((key) => api<InitiateResult>('POST', `/orders/${encodeURIComponent(orderNumber)}/payment/retry`, { paymentMethod }, { 'Idempotency-Key': key }));
    } catch (e) {
      const expired = e instanceof ApiError && (e.code === 'INVALID_TRANSITION' || e.code === 'NOT_FOUND');
      setState(expired ? { step: 'expired', orderNumber } : { step: 'failed', orderNumber, reason: errorText(e) });
    }
  }, [api, follow]);

  return { state, place, retry };
}
