// Footer (product.md §4.3): newsletter band → logo + tagline → TYPE / CONNECT / POLICIES → payment methods →
// copyright and credit. Dark (ink-900); links in white / brand-300 (design-system.md §2.3).
import { whatsappHref, type Navigation, type PublicSettings } from '@artq/shared';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { NewsletterForm } from './NewsletterForm';
import { PAYMENT_METHODS, POLICY_LINKS } from './links';

const heading = 'font-eyebrow text-[13px] uppercase tracking-[0.12em] text-white';
const linkCls = 'text-sm text-sidebar-text hover:text-brand-300 hover:underline';

function Column({ title, children }: { title: string; children: ReactNode }) {
  return <div><h2 className={heading}>{title}</h2><ul className="mt-4 space-y-2.5">{children}</ul></div>;
}

export function Footer({ navigation, settings, year = new Date().getFullYear() }: { navigation: Navigation; settings: PublicSettings; year?: number }) {
  const wa = whatsappHref(settings.store.whatsapp);
  const ext = (href: string, label: string) => <li><a href={href} target="_blank" rel="noopener noreferrer" className={linkCls}>{label}{' '}<span className="sr-only">(opens in a new tab)</span></a></li>;
  return (
    <footer className="bg-ink-900 text-white">
      <section aria-labelledby="newsletter-heading" className="border-b border-white/10">
        <div className="mx-auto flex max-w-[1320px] flex-col gap-6 px-4 py-10 md:flex-row md:items-end md:justify-between md:px-6 lg:px-8">
          <div>
            <h2 id="newsletter-heading" className="font-display text-2xl font-semibold">Join the ArtQ circle</h2>
            <p className="mt-1 text-sm text-sidebar-text">Be the first to hear about new moulds, resins and colours.</p>
          </div>
          <NewsletterForm />
        </div>
      </section>
      <div className="mx-auto grid max-w-[1320px] gap-10 px-4 py-12 md:grid-cols-2 md:px-6 lg:grid-cols-[1.4fr_1fr_1fr_1fr] lg:px-8">
        <div>
          <Link href="/" className="font-display text-2xl font-semibold tracking-[0.25em]">ARTQ<span className="sr-only">, home</span></Link>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-sidebar-text">Handcrafted resin art and wooden frames, bringing natural beauty into your everyday spaces.</p>
        </div>
        <Column title="Type">
          {navigation.types.length === 0
            ? <li><Link href="/shop" className={linkCls}>Shop all</Link></li>
            : navigation.types.map((t) => <li key={t.id}><Link href={t.href} className={linkCls}>{t.name}</Link></li>)}
        </Column>
        <Column title="Connect">
          <li><Link href="/about" className={linkCls}>About Our Craft</Link></li>
          <li><Link href="/contact" className={linkCls}>Contact Us</Link></li>
          <li><Link href="/faqs" className={linkCls}>FAQs</Link></li>
          {settings.social.instagram && ext(settings.social.instagram, 'Instagram')}
          {wa && ext(wa, 'WhatsApp')}
        </Column>
        <Column title="Policies">
          {POLICY_LINKS.map((l) => <li key={l.href}><Link href={l.href} className={linkCls}>{l.label}</Link></li>)}
        </Column>
      </div>
      <div className="mx-auto max-w-[1320px] px-4 md:px-6 lg:px-8">
        <h2 className="sr-only">We accept</h2>
        <ul className="flex flex-wrap gap-2 border-t border-white/10 py-6">
          {PAYMENT_METHODS.map((p) => <li key={p} className="rounded border border-sidebar-muted px-2.5 py-1 text-xs font-medium text-sidebar-text">{p}</li>)}
        </ul>
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-[1320px] flex-col gap-1 px-4 py-5 text-xs text-sidebar-text md:flex-row md:justify-between md:px-6 lg:px-8">
          <p>© {year} ART Q. ALL RIGHTS RESERVED.</p>
          <p>powered by Eayila Consultancy</p>
        </div>
      </div>
    </footer>
  );
}
