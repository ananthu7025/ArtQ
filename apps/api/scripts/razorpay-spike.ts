// Task 4.0: confirm on the Razorpay TEST account what architecture.md §7.3 assumes but could not verify from the docs.
//   node --env-file=.env --import tsx scripts/razorpay-spike.ts orders            (no payment needed)
//   node --env-file=.env --import tsx scripts/razorpay-spike.ts payment <pay_id>  (after one test payment)
// Refuses live keys. Prints findings as JSON; never prints the key secret. Creates only test-mode orders (₹1).
const KEY_ID = process.env.RAZORPAY_KEY_ID ?? '';
const SECRET = process.env.RAZORPAY_KEY_SECRET ?? '';
if (!KEY_ID.startsWith('rzp_test_') || !SECRET) throw new Error('RAZORPAY_KEY_ID must be a test key (rzp_test_…) and RAZORPAY_KEY_SECRET must be set');

const BASE = 'https://api.razorpay.com/v1';
const auth = `Basic ${Buffer.from(`${KEY_ID}:${SECRET}`).toString('base64')}`;
type Res = { status: number; body: unknown; headers: Record<string, string> };
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: auth, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, headers: Object.fromEntries([...res.headers].filter(([k]) => k.startsWith('x-') || k === 'content-type')) };
}
const findings: Record<string, unknown> = {};
const note = (k: string, v: unknown) => { findings[k] = v; };

async function orders() {
  const receipt = `AQA_SPIKE_${Date.now().toString(36)}`;
  const created = await call('POST', '/orders', { amount: 100, currency: 'INR', receipt, notes: { aq_order: 'SPIKE-1', purpose: 'task 4.0 spike' } });
  note('1_create_order', { status: created.status, body: created.body });
  const orderId = (created.body as { id?: string }).id;

  const byReceipt = await call('GET', `/orders?receipt=${encodeURIComponent(receipt)}`);
  const items = (byReceipt.body as { items?: { id: string; receipt: string }[] }).items ?? [];
  note('2_lookup_by_receipt', { status: byReceipt.status, count: items.length, matches: items.map((o) => ({ id: o.id, receipt: o.receipt })), found: items.some((o) => o.id === orderId) });

  const dup = await call('POST', '/orders', { amount: 100, currency: 'INR', receipt, notes: { aq_order: 'SPIKE-1-dup' } });
  note('3_duplicate_receipt', { status: dup.status, body: dup.body });
  const after = await call('GET', `/orders?receipt=${encodeURIComponent(receipt)}`);
  note('3b_lookup_after_duplicate', { count: ((after.body as { items?: unknown[] }).items ?? []).length });

  const fetched = await call('GET', `/orders/${orderId}`);
  note('4_fetch_order', { status: fetched.status, status_field: (fetched.body as { status?: string }).status, attempts: (fetched.body as { attempts?: number }).attempts });
  const payments = await call('GET', `/orders/${orderId}/payments`);
  note('5_order_payments_before_paying', { status: payments.status, body: payments.body });

  note('6_errors', {
    unknown_order: await call('GET', '/orders/order_doesnotexist0'),
    bad_amount: await call('POST', '/orders', { amount: 0, currency: 'INR', receipt: `${receipt}_x` }),
    unknown_payment_fetch: await call('GET', '/payments/pay_doesnotexist00'),
    unknown_payment_capture: await call('POST', '/payments/pay_doesnotexist00/capture', { amount: 100, currency: 'INR' }),
    unknown_payment_refund: await call('POST', '/payments/pay_doesnotexist00/refund', { amount: 100, receipt: 'AQR_SPIKE_1' }, { 'X-Refund-Idempotency': 'artq-refund-spike-a1' }),
  });
  note('order_for_test_payment', { order_id: orderId, amount: 100, receipt });
}

async function payment(id: string) {
  const p = await call('GET', `/payments/${id}`);
  const pay = p.body as { status?: string; captured?: boolean; amount?: number; order_id?: string; amount_refunded?: number; method?: string };
  note('7_payment', { status: p.status, payment_status: pay.status, captured: pay.captured, amount: pay.amount, order_id: pay.order_id, amount_refunded: pay.amount_refunded, method: pay.method });
  note('7b_auto_capture', pay.status === 'captured' ? 'ON: payment arrived captured' : pay.status === 'authorized' ? 'OFF: payment arrived authorized' : `payment is ${pay.status}`);
  if (pay.order_id) note('8_order_payments', await call('GET', `/orders/${pay.order_id}/payments`));
  if (pay.status === 'authorized') {
    const cap = await call('POST', `/payments/${id}/capture`, { amount: pay.amount, currency: 'INR' });
    note('9_capture', { status: cap.status, payment_status: (cap.body as { status?: string }).status });
    note('9b_capture_again', await call('POST', `/payments/${id}/capture`, { amount: pay.amount, currency: 'INR' }));
  }
  const key = `artq-refund-spike-${Date.now().toString(36)}-a1`;
  const body = { amount: 100, speed: 'normal', receipt: `AQR_SPIKE_${Date.now().toString(36)}`, notes: { aq_refund_id: 'spike-1' } };
  const r1 = await call('POST', `/payments/${id}/refund`, body, { 'X-Refund-Idempotency': key });
  note('10_refund', { status: r1.status, body: r1.body });
  note('11_refund_same_key_same_body', await call('POST', `/payments/${id}/refund`, body, { 'X-Refund-Idempotency': key }));
  note('12_refund_same_key_other_body', await call('POST', `/payments/${id}/refund`, { ...body, notes: { aq_refund_id: 'spike-1-changed' } }, { 'X-Refund-Idempotency': key }));
  note('13_refund_reused_receipt_new_key', await call('POST', `/payments/${id}/refund`, { ...body }, { 'X-Refund-Idempotency': `${key}-b` }));
  note('14_refunds_list', await call('GET', `/payments/${id}/refunds`));
  const after = await call('GET', `/payments/${id}`);
  note('15_payment_after_refund', { payment_status: (after.body as { status?: string }).status, amount_refunded: (after.body as { amount_refunded?: number }).amount_refunded, refund_status: (after.body as { refund_status?: string }).refund_status });
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'orders') await orders();
else if (mode === 'payment' && arg?.startsWith('pay_')) await payment(arg);
else throw new Error('usage: razorpay-spike.ts orders | payment <pay_id>');
process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
