import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AnnouncementBar } from '../components/layout/AnnouncementBar';
import { Footer } from '../components/layout/Footer';
import { Header } from '../components/layout/Header';
import { SiteToaster } from '../components/layout/SiteToaster';
import { WhatsAppButton } from '../components/layout/WhatsAppButton';
import { ShopProvider } from '../components/shop/ShopProvider';
import { loadLayout } from '../lib/api';
import { inter, playfair, tenor } from '../lib/fonts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ArtQ: Wood Moulds & Resins', template: '%s | ArtQ' },
  description: 'Resin art supplies, wooden frames, moulds and pigments, shipped all over India.',
};
export const viewport: Viewport = { themeColor: '#ffffff', viewportFit: 'cover' };
// Every page is regenerated at most once a minute (architecture.md §8 ISR); the layout's API calls use the same window.
export const revalidate = 60;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { navigation, settings } = await loadLayout();
  return (
    <html lang="en-IN" className={`${inter.variable} ${playfair.variable} ${tenor.variable}`}>
      <body className="flex min-h-dvh flex-col">
        <a href="#main" className="sr-only z-[80] rounded-md bg-brand-700 px-4 py-3 font-semibold text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Skip to content</a>
        <ShopProvider>
          <AnnouncementBar enabled={settings.announcement.enabled} messages={settings.announcement.messages} />
          <Header navigation={navigation} />
          <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">{children}</main>
          <Footer navigation={navigation} settings={settings} />
          <WhatsAppButton number={settings.store.whatsapp} />
          <SiteToaster />
        </ShopProvider>
      </body>
    </html>
  );
}
