import type { Metadata } from 'next';
import { TrackOrderView } from '../../../components/orders/views';

// Personal and token-bearing: never indexed, and the token is not sent on to other sites.
export const metadata: Metadata = { title: 'Your order', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function TrackPage({ params, searchParams }: { params: Promise<{ orderNumber: string }>; searchParams: Promise<{ token?: string | string[] }> }) {
  const [{ orderNumber }, q] = await Promise.all([params, searchParams]);
  return <TrackOrderView orderNumber={orderNumber} token={typeof q.token === 'string' ? q.token : null} />;
}
