import Link from 'next/link';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-20 text-center">
      <p className="font-eyebrow text-[13px] uppercase tracking-[0.12em] text-ink-700">Error 404</p>
      <h1 className="font-display mt-2 text-[26px] font-semibold text-ink-900 md:text-4xl">We couldn’t find that page</h1>
      <p className="mt-3 text-ink-700">It may have moved, or the link may be out of date.</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/" className="inline-flex h-12 items-center rounded-md bg-brand-700 px-6 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800">Go to home</Link>
        <Link href="/shop" className="inline-flex h-12 items-center rounded-md border-[1.5px] border-ink-900 px-6 text-sm font-semibold uppercase tracking-[0.06em] text-ink-900 hover:bg-ink-900 hover:text-white">Shop all products</Link>
      </div>
    </div>
  );
}
