import type { Metadata } from 'next';
import { AccountOrderView } from '../../../../components/orders/views';

export const metadata: Metadata = { title: 'Your order', robots: { index: false, follow: false } };

export default async function AccountOrderPage({ params }: { params: Promise<{ orderNumber: string }> }) {
  const { orderNumber } = await params;
  return <AccountOrderView orderNumber={orderNumber} />;
}
