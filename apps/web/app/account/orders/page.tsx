import type { Metadata } from 'next';
import { OrdersListView } from '../../../components/orders/views';

export const metadata: Metadata = { title: 'Your orders', robots: { index: false, follow: false } };

export default function OrdersPage() {
  return <OrdersListView />;
}
