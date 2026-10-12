// Newsletter unsubscribe (task 6.3): the link in every newsletter email. Opening it only shows which address it is for;
// the button unsubscribes (so a mail scanner following the link changes nothing).
import type { Metadata } from 'next';
import { UnsubscribeView } from '../../../components/newsletter/UnsubscribeView';

// Token-bearing: never indexed, and the token is not sent on to other sites.
export const metadata: Metadata = { title: 'Unsubscribe', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const q = await searchParams;
  return (
    <div className="mx-auto w-full max-w-[560px] px-4 py-12 md:py-16">
      <h1 className="font-display text-[28px] font-semibold text-ink-900 md:text-[32px]">Newsletter</h1>
      <UnsubscribeView token={typeof q.token === 'string' ? q.token : null} />
    </div>
  );
}
