// Task 4.0 helper: a local page to make ONE Razorpay test-mode payment (₹1) for the spike.
//   node --env-file=.env scripts/razorpay-test-checkout.mjs      → open http://127.0.0.1:4400
// Each page load creates a fresh ₹1 test order and opens Razorpay Checkout; after paying, the page shows the payment id
// for `razorpay-spike.ts payment <pay_id>`. Test keys only; the secret never reaches the browser; listens on 127.0.0.1.
import { createServer } from 'node:http';

const KEY_ID = process.env.RAZORPAY_KEY_ID ?? '';
const SECRET = process.env.RAZORPAY_KEY_SECRET ?? '';
if (!KEY_ID.startsWith('rzp_test_') || !SECRET) throw new Error('test keys only (RAZORPAY_KEY_ID=rzp_test_…)');
const auth = `Basic ${Buffer.from(`${KEY_ID}:${SECRET}`).toString('base64')}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

createServer(async (req, res) => {
  if (req.url !== '/') { res.writeHead(404).end(); return; }
  const receipt = `AQA_SPIKE_PAY_${Date.now().toString(36)}`;
  const r = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 100, currency: 'INR', receipt, notes: { purpose: 'task 4.0 spike test payment' } }) });
  const order = await r.json();
  if (!r.ok) { res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`Could not create the test order: ${JSON.stringify(order)}`); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(`<!doctype html><meta charset="utf-8"><title>ArtQ Razorpay test payment</title>
<body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px">
<h1>Razorpay test payment (₹1, test mode)</h1>
<p>Order <code>${esc(order.id)}</code> · receipt <code>${esc(receipt)}</code></p>
<p>Pay with UPI ID <b>success@razorpay</b>, or a test card from Razorpay's test-card list, then copy the payment id below.</p>
<button id="pay" style="font-size:18px;padding:12px 24px">Pay ₹1 (test)</button>
<pre id="out" style="background:#f1f5f9;padding:12px;white-space:pre-wrap"></pre>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
const out = document.getElementById('out');
const rzp = new Razorpay({ key: ${JSON.stringify(KEY_ID)}, order_id: ${JSON.stringify(order.id)}, amount: 100, currency: 'INR', name: 'ArtQ (test)', description: 'Task 4.0 spike',
  handler: (r) => { out.textContent = 'Paid. Payment id: ' + r.razorpay_payment_id + '\\nOrder: ' + r.razorpay_order_id + '\\n(Copy the payment id back to Claude.)'; },
  modal: { ondismiss: () => { out.textContent += '\\nCheckout closed.'; } } });
rzp.on('payment.failed', (r) => { out.textContent = 'Payment failed: ' + (r.error && r.error.description); });
document.getElementById('pay').onclick = () => rzp.open();
</script></body>`);
}).listen(4400, '127.0.0.1', () => console.log('Open http://127.0.0.1:4400 to make one ₹1 Razorpay TEST payment'));
