import type { Metadata } from 'next';
import { CartPage } from '../../components/cart/CartPage';

export const metadata: Metadata = { title: 'Your cart', robots: { index: false, follow: true } };

export default function Cart() {
  return <CartPage />;
}
