// Order placed (product.md §5.8). Task 4.6 shows the order number; task 4.10 adds the items, total, address, delivery
// estimate and the guest "Set a password" offer from the order API.
import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';

export const metadata: Metadata = { title: 'Order placed', robots: { index: false, follow: false } };
type Props = { params: Promise<{ orderNumber: string }> };

export default async function OrderPlaced({ params }: Props) {
  const { orderNumber } = await params;
  const n = decodeURIComponent(orderNumber).replace(/[^A-Za-z0-9-]/g, '').slice(0, 20);
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-16 text-center">
      <CheckCircle2 aria-hidden size={48} className="mx-auto text-success-700" />
      <h1 className="mt-4 font-display text-[28px] font-semibold text-ink-900 md:text-[34px]">Thank you! Your order is placed.</h1>
      <p className="mt-2 text-ink-700">Order <strong className="font-mono text-ink-900">{n}</strong>. We’ve emailed your confirmation, and we’ll email you again when it ships.</p>
      <Link href="/shop" className="mt-8 inline-flex h-12 items-center justify-center rounded-md bg-brand-700 px-6 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800 md:h-11">Continue shopping</Link>
    </div>
  );
}
