// Razorpay API client for checkout (architecture.md §7.2–7.3, task 4.0 findings). Never called inside a database
// transaction. Errors are classified for the failure matrix: DEFINITIVE (4xx: the order was certainly not created) vs
// UNKNOWN (timeout, 5xx, network: it may or may not exist; recovery looks it up by our receipt).
// Task 4.0: an order created moments ago is not yet found by receipt (seen within ~20 s); duplicate receipts are
// allowed; unknown ids answer 400 BAD_REQUEST_ERROR (no 404).

export type ProviderOrder = { id: string; amount: number; currency: string; receipt: string; createdAt: number };

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
}

type Fetch = typeof fetch;
const BASE = 'https://api.razorpay.com/v1';

export class RazorpayClient implements PaymentProvider {
  private readonly auth: string;
  constructor(readonly keyId: string, secret: string, private readonly fetchImpl: Fetch = fetch, private readonly timeoutMs = 10_000) {
    this.auth = `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}${path}`, {
        method, headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
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

  async createOrder(o: { amount: number; receipt: string; notes: Record<string, string> }): Promise<ProviderOrder> {
    const r = await this.call<{ id: string; amount: number; currency: string; receipt: string; created_at: number }>('POST', '/orders', { amount: o.amount, currency: 'INR', receipt: o.receipt, notes: o.notes });
    return { id: r.id, amount: r.amount, currency: r.currency, receipt: r.receipt, createdAt: r.created_at };
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

  async findOrdersByReceipt(receipt: string): Promise<ProviderOrder[]> {
    if (this.lookupFails) throw new ProviderError('UNKNOWN', 'Razorpay unreachable: TimeoutError');
    return this.orders.filter((o) => o.receipt === receipt && o.visibleAt <= Date.now()).map(({ visibleAt: _v, ...o }) => o);
  }
}
