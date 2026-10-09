// Contact (task 6.2): the store's phone, email and WhatsApp (public settings) and the contact form (saved to the admin
// inbox). The page is static; the form talks to the API in the browser.
import type { Metadata } from 'next';
import Link from 'next/link';
import { ContactForm } from '../../components/content/forms';
import { loadLayout } from '../../lib/api';

export const revalidate = 60;
export const metadata: Metadata = { title: 'Contact us', description: 'Questions about an order, a product or custom work? Write to ArtQ.', alternates: { canonical: '/contact' } };

export default async function ContactPage() {
  const { settings } = await loadLayout();
  const s = settings.store;
  const wa = s.whatsapp?.replace(/\D/g, '');
  return (
    <div className="mx-auto grid w-full max-w-[1100px] gap-10 px-4 py-10 md:grid-cols-[1fr_2fr] md:px-6 md:py-14">
      <div>
        <h1 className="font-display text-[28px] font-semibold text-ink-900 md:text-[36px]">Contact us</h1>
        <p className="mt-3 text-ink-700">Questions about an order or a product? Write to us and we’ll reply within a working day.</p>
        <dl className="mt-6 space-y-3 text-ink-900">
          {s.email && <div><dt className="text-sm text-ink-700">Email</dt><dd><a href={`mailto:${s.email}`} className="font-medium text-brand-700 underline underline-offset-2">{s.email}</a></dd></div>}
          {s.phone && <div><dt className="text-sm text-ink-700">Phone</dt><dd><a href={`tel:${s.phone.replace(/\s/g, '')}`} className="font-medium text-brand-700 underline underline-offset-2">{s.phone}</a></dd></div>}
          {wa && <div><dt className="text-sm text-ink-700">WhatsApp</dt><dd><a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="font-medium text-brand-700 underline underline-offset-2">Chat with us</a></dd></div>}
        </dl>
        <p className="mt-6 text-sm text-ink-700">Want something made for you? <Link href="/custom-work" className="font-medium text-brand-700 underline underline-offset-2">Request custom work</Link>.</p>
      </div>
      <ContactForm />
    </div>
  );
}
