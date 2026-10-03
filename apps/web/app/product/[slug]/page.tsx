// Product detail page (product.md §5.3). Server-rendered from the cached detail (no stock); live prices and stock are
// loaded in the browser by ProductView. Old slugs move permanently (the chosen variant kept); drafts → 404.
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { ProductRow } from '../../../components/home/Sections';
import { ProductView } from '../../../components/product/ProductView';
import { RecentlyViewed } from '../../../components/product/RecentlyViewed';
import { FormAlert } from '../../../components/form/fields';
import { loadLayout, loadProduct, loadRelated } from '../../../lib/api';
import { jsonLdScript, plainText, productJsonLd } from '../../../lib/seo';
import { formatINR } from '@artq/shared';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await loadProduct((await params).slug);
  if (typeof p !== 'object' || 'redirectTo' in p) return {};
  const description = p.metaDescription ?? p.shortDescription ?? (plainText(p.description).slice(0, 160) || undefined);
  return {
    title: p.metaTitle ?? p.name, ...(description ? { description } : {}),
    alternates: { canonical: `/product/${p.slug}` },
    openGraph: { title: p.name, ...(description ? { description } : {}), ...(p.images[0] ? { images: [{ url: p.images[0].url, width: p.images[0].width, height: p.images[0].height }] } : {}) },
  };
}

function Section({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group border-b border-surface-200">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between text-base font-semibold text-ink-900 [&::-webkit-details-marker]:hidden">
        {title}<span aria-hidden className="text-xl text-ink-700 transition-transform group-open:rotate-45">+</span>
      </summary>
      <div className="pb-5 text-[15px] leading-relaxed text-ink-700">{children}</div>
    </details>
  );
}

export default async function ProductPage({ params, searchParams }: Props) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const variant = typeof sp.variant === 'string' && /^[\w.-]{1,64}$/.test(sp.variant) ? sp.variant : null;
  const product = await loadProduct(slug);
  if (product === 'missing') notFound();
  if (typeof product === 'object' && 'redirectTo' in product) permanentRedirect(`/product/${product.redirectTo}${variant ? `?variant=${encodeURIComponent(variant)}` : ''}`);
  if (product === 'unavailable') {
    return <div className="mx-auto max-w-xl px-4 py-20 text-center"><FormAlert>We couldn’t load this product right now. Please try again in a moment.</FormAlert></div>;
  }
  const [related, { settings }] = await Promise.all([loadRelated(slug), loadLayout()]);
  const { shipping, payment, order } = settings;
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(productJsonLd(product)) }} />
      <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-6 md:px-6 lg:px-8">
        <nav aria-label="Breadcrumb" className="mb-4 text-sm text-ink-700">
          <ol className="flex flex-wrap items-center gap-1">
            <li><Link href="/" className="hover:text-brand-700 hover:underline">Home</Link></li>
            <li className="flex items-center gap-1"><span aria-hidden>›</span><Link href={`/type/${product.type.slug}`} className="hover:text-brand-700 hover:underline">{product.type.name}</Link></li>
            {product.category && <li className="flex items-center gap-1"><span aria-hidden>›</span><Link href={`/category/${product.category.slug}`} className="hover:text-brand-700 hover:underline">{product.category.name}</Link></li>}
            <li className="flex items-center gap-1"><span aria-hidden>›</span><span aria-current="page" className="text-ink-900">{product.name}</span></li>
          </ol>
        </nav>
        <ProductView product={product} initialSku={variant} returnWindowHours={order.returnWindowHours} />
        <div className="mt-10 max-w-3xl">
          {product.description && <Section title="Description" open><div className="prose-artq" dangerouslySetInnerHTML={{ __html: product.description }} /></Section>}
          {product.productDetails.length > 0 && <Section title="Product details"><ul className="list-disc space-y-1 pl-5">{product.productDetails.map((d) => <li key={d}>{d}</li>)}</ul></Section>}
          {(product.specificationsCare.length > 0 || product.specifications.length > 0) && (
            <Section title="Specifications & care">
              {product.specifications.length > 0 && <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">{product.specifications.map((s) => <div key={s.label} className="contents"><dt className="font-medium text-ink-900">{s.label}</dt><dd>{s.value}</dd></div>)}</dl>}
              {product.specificationsCare.length > 0 && <ul className="list-disc space-y-1 pl-5">{product.specificationsCare.map((c) => <li key={c}>{c}</li>)}</ul>}
            </Section>
          )}
          {product.howToUse && <Section title="How to use"><p className="whitespace-pre-line">{product.howToUse}</p></Section>}
          <Section title="Shipping & returns">
            <ul className="list-disc space-y-1 pl-5">
              <li>Free shipping on orders above {formatINR(shipping.freeThreshold)}; otherwise charged by weight and destination at checkout.</li>
              <li>Usually delivered in {shipping.estimatedDays.min}–{shipping.estimatedDays.max} days.</li>
              {payment.codEnabled && <li>Cash on delivery for orders from {formatINR(payment.codMin)} to {formatINR(payment.codMax)} (fee {formatINR(payment.codFee)}), where available.</li>}
              <li>Returns accepted within {order.returnWindowHours} hours of delivery. <Link href="/return-policy" className="text-brand-700 underline">Return policy</Link></li>
            </ul>
          </Section>
          {product.techniques.length > 0 && (
            <nav aria-label="Techniques" className="mt-6">
              <p className="mb-2 text-sm font-semibold text-ink-900">Use it for</p>
              <ul className="flex flex-wrap gap-2">{product.techniques.map((t) => <li key={t.slug}><Link href={`/technique/${t.slug}`} className="inline-flex min-h-10 items-center rounded-full border border-border-input px-4 text-sm text-ink-900 hover:border-brand-700 hover:text-brand-700">{t.name}</Link></li>)}</ul>
            </nav>
          )}
        </div>
      </div>
      {related.frequentlyBoughtTogether.length > 0 && <ProductRow id="together-heading" title="Frequently bought together" cards={related.frequentlyBoughtTogether} />}
      {related.similar.length > 0 && <ProductRow id="similar-heading" title="You may also like" cards={related.similar} />}
      <RecentlyViewed productId={product.id} />
    </>
  );
}
