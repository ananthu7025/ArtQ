// Razorpay Checkout in the browser (architecture.md §7.2). The script is loaded once, only when a customer pays. The
// result is what the modal reports; the server decides what it means (POST /checkout/verify re-fetches the payment).
import type { RazorpayCheckout } from '@artq/shared';

export type RazorpayResult =
  | { kind: 'paid'; paymentId: string; signature: string }
  | { kind: 'dismissed' }
  | { kind: 'failed'; paymentId: string | null; reason: string };

type RazorpayCtor = new (o: Record<string, unknown>) => { open(): void; on(event: string, cb: (r: { error?: { description?: string; metadata?: { payment_id?: string } } }) => void): void };
declare global { interface Window { Razorpay?: RazorpayCtor } }

export const RAZORPAY_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
let loading: Promise<RazorpayCtor> | null = null;

export function loadRazorpay(): Promise<RazorpayCtor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  loading ??= new Promise<RazorpayCtor>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = RAZORPAY_SCRIPT;
    s.async = true;
    s.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Razorpay did not load')));
    s.onerror = () => { loading = null; reject(new Error('Razorpay could not be loaded')); };
    document.head.appendChild(s);
  });
  return loading;
}

/** Opens the Razorpay modal for a provider order; resolves once the customer pays, closes it or the payment fails. */
export async function payWithRazorpay(r: RazorpayCheckout, orderNumber: string, load: () => Promise<RazorpayCtor> = loadRazorpay): Promise<RazorpayResult> {
  const Razorpay = await load();
  return new Promise<RazorpayResult>((resolve) => {
    let failed: RazorpayResult | null = null;
    const rzp = new Razorpay({
      key: r.keyId, order_id: r.orderId, amount: r.amount, currency: r.currency, name: r.name, description: `Order ${orderNumber}`, prefill: r.prefill,
      theme: { color: '#00756f' },
      handler: (p: { razorpay_payment_id: string; razorpay_signature: string }) => resolve({ kind: 'paid', paymentId: p.razorpay_payment_id, signature: p.razorpay_signature }),
      // A failure inside the modal leaves it open for another try; when the customer closes it, report the last failure.
      modal: { ondismiss: () => resolve(failed ?? { kind: 'dismissed' }), confirm_close: true },
    });
    rzp.on('payment.failed', (e) => { failed = { kind: 'failed', paymentId: e.error?.metadata?.payment_id ?? null, reason: e.error?.description ?? 'Payment failed' }; });
    rzp.open();
  });
}
