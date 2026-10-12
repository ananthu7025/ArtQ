// FAQs (task 6.2): the active questions by group, in the order staff set (CMS & Messages), each opening in place, with
// FAQPage structured data. Prerendered and refreshed every 60 s; if the API is down the page says so.
import type { Metadata } from 'next';
import Link from 'next/link';
import { loadFaqs } from '../../lib/api';
import { jsonLdScript, withSeo } from '../../lib/seo';

export const revalidate = 60;
export function generateMetadata(): Promise<Metadata> {
  return withSeo('/faqs', { title: 'FAQs', description: 'Answers about orders, shipping, payments, our products and returns.' });
}

export default async function FaqsPage() {
  const faqs = await loadFaqs();
  const all = faqs?.groups.flatMap((g) => g.items) ?? [];
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 md:px-6 md:py-14">
      {all.length > 0 && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: all.map((q) => ({ '@type': 'Question', name: q.question, acceptedAnswer: { '@type': 'Answer', text: q.answer } })) }) }} />}
      <h1 className="font-display text-[28px] font-semibold text-ink-900 md:text-[36px]">Frequently asked questions</h1>
      {faqs === null ? <p className="mt-6 text-ink-700">We couldn’t load the questions just now. Please try again in a minute.</p>
        : faqs.groups.length === 0 ? <p className="mt-6 text-ink-700">No questions yet.</p>
        : faqs.groups.map((g) => (
          <section key={g.group} aria-labelledby={`faq-${g.group}`} className="mt-10">
            <h2 id={`faq-${g.group}`} className="text-lg font-semibold text-ink-900">{g.label}</h2>
            <div className="mt-3 divide-y divide-surface-200 border-y border-surface-200">
              {g.items.map((q) => (
                <details key={q.question} className="group py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-ink-900 [&::-webkit-details-marker]:hidden">
                    {q.question}<span aria-hidden className="text-xl leading-none text-ink-700 transition-transform group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-3 whitespace-pre-line text-ink-800">{q.answer}</p>
                </details>
              ))}
            </div>
          </section>
        ))}
      <p className="mt-12 text-ink-700">Still have a question? <Link href="/contact" className="font-medium text-brand-700 underline underline-offset-2">Write to us</Link>.</p>
    </div>
  );
}
