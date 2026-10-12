// Content pages (task 6.2; product.md §3): /about, the policy pages linked from the footer (/terms, /privacy-policy,
// /shipping-policy, /return-policy, /cancellation-policy) and any other page staff publish in CMS & Messages. Fixed
// routes (/shop, /cart, …) take precedence over this one. Unknown or unpublished → the 404 page. The HTML was cleaned by
// the API (the product-description allowlist). Prerendered and refreshed every 60 s.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { loadPage } from '../../lib/api';
import { withSeo } from '../../lib/seo';

export const revalidate = 60;
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await loadPage((await params).slug);
  if (typeof p !== 'object') return {};
  return withSeo(`/${p.slug}`, { title: p.metaTitle ?? p.title, ...(p.metaDescription ? { description: p.metaDescription } : {}) });
}

const updated = new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeZone: 'Asia/Kolkata' });

export default async function ContentPage({ params }: Props) {
  const p = await loadPage((await params).slug);
  if (p === 'missing') notFound();
  if (p === 'unavailable') {
    return <div className="mx-auto max-w-3xl px-4 py-16"><h1 className="font-display text-[28px] font-semibold text-ink-900">This page is taking a break</h1><p className="mt-3 text-ink-700">We couldn’t load it just now. Please try again in a minute.</p></div>;
  }
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-10 md:px-6 md:py-14">
      <h1 className="font-display text-[28px] font-semibold text-ink-900 md:text-[36px]">{p.title}</h1>
      <p className="mt-2 text-sm text-ink-700">Last updated {updated.format(new Date(p.updatedAt))}</p>
      <div className="prose-artq mt-8 text-[15px] leading-relaxed text-ink-800" dangerouslySetInnerHTML={{ __html: p.content }} />
    </article>
  );
}
