import type { Metadata } from 'next';
import { CheckoutPage } from '../../components/checkout/CheckoutPage';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false, follow: false } };

export default function Checkout() {
  return <CheckoutPage />;
}
