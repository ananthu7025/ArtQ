import { formatINR } from '@artq/shared';
import { Button } from '@artq/ui';

// Phase 0 placeholder: proves SSR + shared packages + tokens. Real home page is task 3.3.
export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 text-center">
      <h1 style={{ fontFamily: 'var(--font-display)', color: 'var(--ink-900)' }} className="text-4xl font-semibold tracking-widest">ARTQ</h1>
      <p className="mt-2 uppercase tracking-[0.3em]">Wood moulds &amp; resins</p>
      <p className="mt-8">2:1 Epoxy Resin from {formatINR(49900)}</p>
      <div className="mt-6"><Button>Shop now</Button></div>
    </main>
  );
}
