import type { Metadata } from 'next';
import { WishlistView } from '../../components/account/WishlistView';

export const metadata: Metadata = { title: 'Wishlist', robots: { index: false, follow: true } };

export default function WishlistPage() {
  return <WishlistView />;
}
