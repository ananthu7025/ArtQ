// Task 4.7: the Razorpay client classifies failures for the failure matrix (DEFINITIVE vs UNKNOWN) and never leaks the
// secret; the receipt lookup returns only that receipt's orders, oldest first.
import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { checkoutSignatureMatches, FakeRazorpay, ProviderError, RazorpayClient } from '../src/payments/razorpay.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const client = (f: (url: string, init: RequestInit) => Promise<Response>) => new RazorpayClient('rzp_test_abc', 'very-secret', f as unknown as typeof fetch, 50);
const kind = async (p: Promise<unknown>) => { const e = await p.catch((x: unknown) => x); expect(e).toBeInstanceOf(ProviderError); return [(e as ProviderError).kind, (e as ProviderError).httpStatus]; };

describe('RazorpayClient', () => {
  it('creates an order with basic auth, INR, our receipt and notes', async () => {
    const f = vi.fn(async () => json(200, { id: 'order_1', amount: 100, currency: 'INR', receipt: 'AQA_1', created_at: 5 }));
    expect(await client(f).createOrder({ amount: 100, receipt: 'AQA_1', notes: { order: 'AQ1' } })).toEqual({ id: 'order_1', amount: 100, currency: 'INR', receipt: 'AQA_1', createdAt: 5 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/orders');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('rzp_test_abc:very-secret').toString('base64')}`);
    expect(JSON.parse(String(init.body))).toEqual({ amount: 100, currency: 'INR', receipt: 'AQA_1', notes: { order: 'AQ1' } });
  });
  it('4xx → DEFINITIVE (with the provider description); 5xx, 429, network, timeout, garbage → UNKNOWN', async () => {
    expect(await kind(client(async () => json(400, { error: { description: 'The amount must be atleast INR 1.00' } })).createOrder({ amount: 1, receipt: 'r', notes: {} }))).toEqual(['DEFINITIVE', 400]);
    expect(await kind(client(async () => json(401, { error: { description: 'Authentication failed' } })).createOrder({ amount: 1, receipt: 'r', notes: {} }))).toEqual(['DEFINITIVE', 401]);
    expect(await kind(client(async () => json(502, {})).createOrder({ amount: 1, receipt: 'r', notes: {} }))).toEqual(['UNKNOWN', 502]);
    expect(await kind(client(async () => json(429, {})).createOrder({ amount: 1, receipt: 'r', notes: {} }))).toEqual(['UNKNOWN', 429]);
    expect(await kind(client(async () => { throw new TypeError('fetch failed'); }).createOrder({ amount: 1, receipt: 'r', notes: {} }))).toEqual(['UNKNOWN', null]);
    expect(await kind(client((_u, init) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))).createOrder({ amount: 1, receipt: 'r', notes: {} }))).toEqual(['UNKNOWN', null]);
    expect(await kind(client(async () => new Response('<html>', { status: 200 })).createOrder({ amount: 1, receipt: 'r', notes: {} }))).toEqual(['UNKNOWN', 200]);
    const e = await client(async () => json(400, { error: { description: 'bad' } })).createOrder({ amount: 1, receipt: 'r', notes: {} }).catch((x: Error) => x);
    expect(String((e as Error).message)).not.toContain('very-secret');
  });
  it('receipt lookup: only that receipt, oldest first (duplicates allowed by Razorpay)', async () => {
    const f = vi.fn(async () => json(200, { items: [
      { id: 'order_b', amount: 1, currency: 'INR', receipt: 'AQA_7', created_at: 20 }, { id: 'order_x', amount: 1, currency: 'INR', receipt: 'AQA_70', created_at: 1 },
      { id: 'order_a', amount: 1, currency: 'INR', receipt: 'AQA_7', created_at: 10 },
    ] }));
    expect((await client(f).findOrdersByReceipt('AQA_7')).map((o) => o.id)).toEqual(['order_a', 'order_b']);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://api.razorpay.com/v1/orders?receipt=AQA_7');
  });
});

describe('checkout signature', () => {
  it('HMAC-SHA256 of "<order>|<payment>" with the key secret; anything else fails', () => {
    const sig = createHmac('sha256', 'very-secret').update('order_1|pay_1').digest('hex');
    const c = client(async () => json(200, {}));
    expect(c.verifySignature('order_1', 'pay_1', sig)).toBe(true);
    expect(c.verifySignature('order_2', 'pay_1', sig)).toBe(false);
    expect(c.verifySignature('order_1', 'pay_2', sig)).toBe(false);
    expect(checkoutSignatureMatches('other-secret', 'order_1', 'pay_1', sig)).toBe(false);
    expect(c.verifySignature('order_1', 'pay_1', 'not-hex')).toBe(false);
    expect(c.verifySignature('order_1', 'pay_1', sig.toUpperCase())).toBe(true);
  });
  it('payments: fetched one, and an order\'s list', async () => {
    const raw = { id: 'pay_1', order_id: 'order_1', amount: 100, currency: 'INR', status: 'captured', amount_refunded: 0, method: 'upi', created_at: 7 };
    expect(await client(async () => json(200, raw)).fetchPayment('pay_1')).toEqual({ id: 'pay_1', orderId: 'order_1', amount: 100, currency: 'INR', status: 'captured', amountRefunded: 0, method: 'upi', createdAt: 7, raw });
    expect((await client(async () => json(200, { items: [raw] })).orderPayments('order_1')).map((p) => p.id)).toEqual(['pay_1']);
    expect(await kind(client(async () => json(400, { error: { description: 'The id provided does not exist' } })).fetchPayment('pay_x'))).toEqual(['DEFINITIVE', 400]);
  });
});

describe('FakeRazorpay', () => {
  it('orders appear in the receipt lookup after the lag; scripted failures', async () => {
    const f = new FakeRazorpay();
    f.lookupLagMs = 30;
    const o = await f.createOrder({ amount: 1, receipt: 'R1', notes: {} });
    expect(await f.findOrdersByReceipt('R1')).toEqual([]);
    await new Promise((r) => setTimeout(r, 40));
    expect((await f.findOrdersByReceipt('R1')).map((x) => x.id)).toEqual([o.id]);
    f.next = ['definitive', 'created-then-unknown'];
    expect(await kind(f.createOrder({ amount: 1, receipt: 'R2', notes: {} }))).toEqual(['DEFINITIVE', 400]);
    expect(await kind(f.createOrder({ amount: 1, receipt: 'R3', notes: {} }))).toEqual(['UNKNOWN', null]);
    expect(f.orders.map((x) => x.receipt)).toEqual(['R1', 'R3']);
  });
});
