// Order placed (product.md §5.8). The order is private to the browser or account that placed it, so the details load in
// the browser (OrderPlacedView), never in the server render.
import type { Metadata } from 'next';
import { OrderPlacedView } from '../../../../components/checkout/OrderPlacedView';

export const metadata: Metadata = { title: 'Order placed', robots: { index: false, follow: false } };
type Props = { params: Promise<{ orderNumber: string }> };

export default async function OrderPlaced({ params }: Props) {
  const { orderNumber } = await params;
  const n = decodeURIComponent(orderNumber).replace(/[^A-Za-z0-9-]/g, '').slice(0, 20);
  return <OrderPlacedView orderNumber={n} />;
}
