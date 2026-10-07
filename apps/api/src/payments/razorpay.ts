// Razorpay API client for checkout (architecture.md §7.2–7.3, task 4.0 findings). Never called inside a database
// transaction. Errors are classified for the failure matrix: DEFINITIVE (4xx: the order was certainly not created) vs
// UNKNOWN (timeout, 5xx, network: it may or may not exist; recovery looks it up by our receipt).
// Task 4.0: an order created moments ago is not yet found by receipt (seen within ~20 s); duplicate receipts are
// allowed; unknown ids answer 400 BAD_REQUEST_ERROR (no 404).

import { createHmac, timingSafeEqual } from 'node:crypto';

export type ProviderOrder = { id: string; amount: number; currency: string; receipt: string; createdAt: number };
/** A payment as Razorpay reports it (the authoritative snapshot passed to aq_apply_provider_payment). */
export type ProviderPayment = {
  id: string; orderId: string | null; amount: number; currency: string; status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  amountRefunded: number; method: string | null; createdAt: number; raw: unknown;
};
type RawPayment = { id: string; order_id: string | null; amount: number; currency: string; status: ProviderPayment['status']; amount_refunded?: number; method?: string | null; created_at: number };
/** A refund as Razorpay reports it. */
export type ProviderRefund = { id: string; paymentId: string; amount: number; status: 'pending' | 'processed' | 'failed'; receipt: string | null; notes: Record<string, string>; createdAt: number };
type RawRefund = { id: string; payment_id: string; amount: number; status: ProviderRefund['status']; receipt?: string | null; notes?: Record<string, string> | unknown[]; created_at: number };
const toRefund = (r: RawRefund): ProviderRefund => ({ id: r.id, paymentId: r.payment_id, amount: r.amount, status: r.status, receipt: r.receipt ?? null, notes: Array.isArray(r.notes) ? {} : (r.notes ?? {}), createdAt: r.created_at });
const toPayment = (r: RawPayment): ProviderPayment => ({ id: r.id, orderId: r.order_id, amount: r.amount, currency: r.currency, status: r.status, amountRefunded: r.amount_refunded ?? 0, method: r.method ?? null, createdAt: r.created_at, raw: r });

export class ProviderError extends Error {
  constructor(readonly kind: 'DEFINITIVE' | 'UNKNOWN', message: string, readonly httpStatus: number | null = null) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** What checkout needs from the payment provider (the real client, or a stub in tests). */
export interface PaymentProvider {
  readonly keyId: string;
  createOrder(o: { amount: number; receipt: string; notes: Record<string, string> }): Promise<ProviderOrder>;
  /** Orders with this receipt, oldest first (the earliest is adopted when several exist). */
  findOrdersByReceipt(receipt: string): Promise<ProviderOrder[]>;
  /** One payment (unknown ids: DEFINITIVE, Razorpay answers 400). */
  fetchPayment(paymentId: string): Promise<ProviderPayment>;
  /** Every payment attempt on a provider order (created, failed, authorized, captured…). */
  orderPayments(providerOrderId: string): Promise<ProviderPayment[]>;
  /** Checkout signature: HMAC-SHA256("<provider order id>|<payment id>", key secret), compared in constant time. */
  verifySignature(providerOrderId: string, paymentId: string, signature: string): boolean;
  /** Capture an authorized payment (auto-capture is ON, task 4.0: only stale authorizations need this). "Already captured" is success. */
  capturePayment(paymentId: string, amount: number): Promise<void>;
  /** Payments created in [from, to] (unix seconds), all pages. */
  listPayments(from: number, to: number): Promise<ProviderPayment[]>;
  /** Refunds created in [from, to] (unix seconds), all pages. */
  listRefunds(from: number, to: number): Promise<ProviderRefund[]>;
  fetchRefund(refundId: string): Promise<ProviderRefund>;
  /** Every refund of one payment (reconciliation, and the check before a definitive failure is recorded). */
  paymentRefunds(paymentId: string): Promise<ProviderRefund[]>;
  /**
   * POST /payments/{id}/refund with `X-Refund-Idempotency: <key>` and exactly the stored body (architecture.md §10.2).
   * Errors keep Razorpay's HTTP status and description so the caller can tell "still in progress" (409) and "different
   * request with the same key" from a definitive refusal.
   */
  createRefund(paymentId: string, body: RefundRequestBody, idempotencyKey: string): Promise<ProviderRefund>;
}

/** The immutable refund request stored on each attempt (database.md, aq_new_refund_attempt). */
export type RefundRequestBody = { amount: number; speed: 'normal'; receipt: string; notes: Record<string, string | number> };

/** HMAC-SHA256 hex of "<order id>|<payment id>" (Razorpay Checkout), compared in constant time. */
export function checkoutSignatureMatches(secret: string, providerOrderId: string, paymentId: string, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(`${providerOrderId}|${paymentId}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

type Fetch = typeof fetch;
const BASE = 'https://api.razorpay.com/v1';

export class RazorpayClient implements PaymentProvider {
  private readonly auth: string;
  constructor(readonly keyId: string, private readonly secret: string, private readonly fetchImpl: Fetch = fetch, private readonly timeoutMs = 10_000) {
    this.auth = `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}${path}`, {
        method, headers: { Authorization: this.auth, 'Content-Type': 'application/json', ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ProviderError('UNKNOWN', `Razorpay unreachable: ${(e as Error).name}`);
    }
    const text = await res.text().catch(() => '');
    if (res.status >= 500 || res.status === 429) throw new ProviderError('UNKNOWN', `Razorpay ${res.status}`, res.status);
    if (!res.ok) {
      let description = text.slice(0, 300);
      try { description = (JSON.parse(text) as { error?: { description?: string } }).error?.description ?? description; } catch { /* not JSON */ }
      throw new ProviderError('DEFINITIVE', `Razorpay ${res.status}: ${description}`, res.status);
    }
    try { return JSON.parse(text) as T; } catch { throw new ProviderError('UNKNOWN', 'Razorpay sent an unreadable response', res.status); }
  }

  verifySignature(providerOrderId: string, paymentId: string, signature: string): boolean {
    return checkoutSignatureMatches(this.secret, providerOrderId, paymentId, signature);
  }

  async createOrder(o: { amount: number; receipt: string; notes: Record<string, string> }): Promise<ProviderOrder> {
    const r = await this.call<{ id: string; amount: number; currency: string; receipt: string; created_at: number }>('POST', '/orders', { amount: o.amount, currency: 'INR', receipt: o.receipt, notes: o.notes });
    return { id: r.id, amount: r.amount, currency: r.currency, receipt: r.receipt, createdAt: r.created_at };
  }

  async fetchPayment(paymentId: string): Promise<ProviderPayment> {
    return toPayment(await this.call<RawPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`));
  }

  async orderPayments(providerOrderId: string): Promise<ProviderPayment[]> {
    return (await this.call<{ items: RawPayment[] }>('GET', `/orders/${encodeURIComponent(providerOrderId)}/payments`)).items.map(toPayment);
  }

  async capturePayment(paymentId: string, amount: number): Promise<void> {
    try { await this.call('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount, currency: 'INR' }); } catch (e) {
      if (e instanceof ProviderError && e.kind === 'DEFINITIVE' && /already been captured/i.test(e.message)) return;   // task 4.0: idempotent
      throw e;
    }
  }

  private async pages<T>(path: string, from: number, to: number): Promise<T[]> {
    const out: T[] = [];
    for (let skip = 0; ; skip += 100) {
      const r = await this.call<{ items: T[] }>('GET', `${path}?from=${from}&to=${to}&count=100&skip=${skip}`);
      out.push(...r.items);
      if (r.items.length < 100 || skip > 100_000) return out;
    }
  }
  async listPayments(from: number, to: number): Promise<ProviderPayment[]> { return (await this.pages<RawPayment>('/payments', from, to)).map(toPayment); }
  async listRefunds(from: number, to: number): Promise<ProviderRefund[]> { return (await this.pages<RawRefund>('/refunds', from, to)).map(toRefund); }
  async fetchRefund(refundId: string): Promise<ProviderRefund> { return toRefund(await this.call<RawRefund>('GET', `/refunds/${encodeURIComponent(refundId)}`)); }
  async paymentRefunds(paymentId: string): Promise<ProviderRefund[]> {
    return (await this.call<{ items: RawRefund[] }>('GET', `/payments/${encodeURIComponent(paymentId)}/refunds?count=100`)).items.map(toRefund);
  }
  async createRefund(paymentId: string, body: RefundRequestBody, idempotencyKey: string): Promise<ProviderRefund> {
    return toRefund(await this.call<RawRefund>('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, body, { 'X-Refund-Idempotency': idempotencyKey }));
  }

  async findOrdersByReceipt(receipt: string): Promise<ProviderOrder[]> {
    const r = await this.call<{ items: { id: string; amount: number; currency: string; receipt: string; created_at: number }[] }>('GET', `/orders?receipt=${encodeURIComponent(receipt)}`);
    return r.items.filter((x) => x.receipt === receipt).map((x) => ({ id: x.id, amount: x.amount, currency: x.currency, receipt: x.receipt, createdAt: x.created_at })).sort((a, b) => a.createdAt - b.createdAt);
  }
}

/**
 * In-memory provider for tests and local runs without keys: orders are created instantly, become findable by receipt
 * after `lookupLagMs` (like the real API), and the next calls can be told to fail or to "crash after creating".
 */
export class FakeRazorpay implements PaymentProvider {
  readonly keyId = 'rzp_test_fake';
  readonly orders: (ProviderOrder & { visibleAt: number })[] = [];
  /** Queue of behaviours for the next createOrder calls. */
  next: ('ok' | 'definitive' | 'unknown' | 'created-then-unknown' | 'created-then-crash')[] = [];
  lookupLagMs = 0;
  createCalls = 0;
  lookupFails = false;
  private static seq = 0;

  async createOrder(o: { amount: number; receipt: string; notes: Record<string, string> }): Promise<ProviderOrder> {
    this.createCalls++;
    const mode = this.next.shift() ?? 'ok';
    if (mode === 'definitive') throw new ProviderError('DEFINITIVE', 'Razorpay 400: The amount must be at least INR 1.00', 400);
    if (mode === 'unknown') throw new ProviderError('UNKNOWN', 'Razorpay unreachable: TimeoutError');
    const order = { id: `order_fake${++FakeRazorpay.seq}`, amount: o.amount, currency: 'INR', receipt: o.receipt, createdAt: Date.now(), visibleAt: Date.now() + this.lookupLagMs };
    this.orders.push(order);
    if (mode === 'created-then-unknown') throw new ProviderError('UNKNOWN', 'Razorpay unreachable: TimeoutError');   // created, but the answer was lost
    if (mode === 'created-then-crash') throw new Error('process killed after the provider created the order');   // AT-03
    return order;
  }

  static readonly SECRET = 'fake-razorpay-secret';
  /** The signature Razorpay Checkout would hand the browser for this payment. */
  sign(providerOrderId: string, paymentId: string): string {
    return createHmac('sha256', FakeRazorpay.SECRET).update(`${providerOrderId}|${paymentId}`).digest('hex');
  }
  verifySignature(providerOrderId: string, paymentId: string, signature: string): boolean {
    return checkoutSignatureMatches(FakeRazorpay.SECRET, providerOrderId, paymentId, signature);
  }

  /** Payments the test "made" (see pay()). */
  readonly payments: ProviderPayment[] = [];
  fetchFails = false;
  /** A customer paying `order` in the Razorpay window (status as the test wants it). */
  pay(providerOrderId: string, o: Partial<Omit<ProviderPayment, 'id' | 'orderId'>> = {}): ProviderPayment {
    const order = this.orders.find((x) => x.id === providerOrderId);
    const p: ProviderPayment = { id: `pay_fake${++FakeRazorpay.seq}`, orderId: providerOrderId, amount: order?.amount ?? 0, currency: 'INR', status: 'captured', amountRefunded: 0, method: 'upi', createdAt: Math.floor(Date.now() / 1000), raw: {}, ...o };
    this.payments.push(p);
    return p;
  }

  async fetchPayment(paymentId: string): Promise<ProviderPayment> {
    if (this.fetchFails) throw new ProviderError('UNKNOWN', 'Razorpay unreachable: TimeoutError');
    const p = this.payments.find((x) => x.id === paymentId);
    if (!p) throw new ProviderError('DEFINITIVE', 'Razorpay 400: The id provided does not exist', 400);
    return { ...p };
  }

  async orderPayments(providerOrderId: string): Promise<ProviderPayment[]> {
    if (this.fetchFails) throw new ProviderError('UNKNOWN', 'Razorpay unreachable: TimeoutError');
    return this.payments.filter((x) => x.orderId === providerOrderId).map((x) => ({ ...x }));
  }

  readonly refunds: ProviderRefund[] = [];
  captureCalls: string[] = [];
  /** Next capture outcomes ('ok' turns the payment captured). */
  captureNext: ('ok' | 'unknown' | 'definitive')[] = [];
  async capturePayment(paymentId: string): Promise<void> {
    this.captureCalls.push(paymentId);
    const mode = this.captureNext.shift() ?? 'ok';
    if (mode === 'unknown') throw new ProviderError('UNKNOWN', 'Razorpay unreachable: TimeoutError');
    if (mode === 'definitive') throw new ProviderError('DEFINITIVE', 'Razorpay 400: capture not allowed', 400);
    const p = this.payments.find((x) => x.id === paymentId);
    if (p && p.status === 'authorized') p.status = 'captured';
  }
  async listPayments(from: number, to: number): Promise<ProviderPayment[]> {
    if (this.fetchFails) throw new ProviderError('UNKNOWN', 'Razorpay unreachable: TimeoutError');
    return this.payments.filter((p) => p.createdAt >= from && p.createdAt <= to).map((p) => ({ ...p }));
  }
  async listRefunds(from: number, to: number): Promise<ProviderRefund[]> {
    return this.refunds.filter((r) => r.createdAt >= from && r.createdAt <= to).map((r) => ({ ...r }));
  }
  /** Next createRefund behaviours: 'ok' (processed at once, as in test mode), 'pending', 'unknown' (lost before
   *  Razorpay saw it), 'created-then-unknown' (made, answer lost), 'in-progress' (409), 'definitive' (400). */
  refundNext: ('ok' | 'pending' | 'unknown' | 'created-then-unknown' | 'in-progress' | 'definitive')[] = [];
  readonly refundCalls: { paymentId: string; key: string; body: RefundRequestBody }[] = [];
  private readonly refundKeys = new Map<string, { body: string; refundId: string }>();
  refundListFails = false;
  async createRefund(paymentId: string, body: RefundRequestBody, key: string): Promise<ProviderRefund> {
    this.refundCalls.push({ paymentId, key, body });
    const seen = this.refundKeys.get(key);
    if (seen) {
      if (seen.body !== JSON.stringify(body)) throw new ProviderError('DEFINITIVE', 'Razorpay 409: Different request with the same idempotency key has already been processed', 409);
      return { ...this.refunds.find((r) => r.id === seen.refundId)! };   // same key + same body: the same refund
    }
    const mode = this.refundNext.shift() ?? 'ok';
    if (mode === 'unknown') throw new ProviderError('UNKNOWN', 'Razorpay unreachable: TimeoutError');
    if (mode === 'in-progress') throw new ProviderError('DEFINITIVE', 'Razorpay 409: Request with the same idempotency key is still in progress', 409);
    if (mode === 'definitive') throw new ProviderError('DEFINITIVE', 'Razorpay 400: The refund amount provided is greater than amount captured', 400);
    const pay = this.payments.find((p) => p.id === paymentId);
    const r: ProviderRefund = { id: `rfnd_fake${++FakeRazorpay.seq}`, paymentId, amount: body.amount, status: mode === 'pending' ? 'pending' : 'processed', receipt: body.receipt,
      notes: Object.fromEntries(Object.entries(body.notes).map(([k, v]) => [k, String(v)])), createdAt: Math.floor(Date.now() / 1000) };
    this.refunds.push(r);
    this.refundKeys.set(key, { body: JSON.stringify(body), refundId: r.id });
    if (pay) pay.amountRefunded += body.amount;
    if (mode === 'created-then-unknown') throw new ProviderError('UNKNOWN', 'Razorpay unreachable: TimeoutError');
    return { ...r };
  }
  async paymentRefunds(paymentId: string): Promise<ProviderRefund[]> {
    if (this.refundListFails) throw new ProviderError('UNKNOWN', 'Razorpay unreachable: TimeoutError');
    return this.refunds.filter((r) => r.paymentId === paymentId).map((r) => ({ ...r }));
  }
  async fetchRefund(refundId: string): Promise<ProviderRefund> {
    const r = this.refunds.find((x) => x.id === refundId);
    if (!r) throw new ProviderError('DEFINITIVE', 'Razorpay 400: The id provided does not exist', 400);
    return { ...r };
  }

  async findOrdersByReceipt(receipt: string): Promise<ProviderOrder[]> {
    if (this.lookupFails) throw new ProviderError('UNKNOWN', 'Razorpay unreachable: TimeoutError');
    return this.orders.filter((o) => o.receipt === receipt && o.visibleAt <= Date.now()).map(({ visibleAt: _v, ...o }) => o);
  }
}
