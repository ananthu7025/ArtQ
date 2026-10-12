import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AnnouncementBar } from '../components/layout/AnnouncementBar';
import { Footer } from '../components/layout/Footer';
import { Header } from '../components/layout/Header';
import { SiteToaster } from '../components/layout/SiteToaster';
import { WhatsAppButton } from '../components/layout/WhatsAppButton';
import { AuthProvider } from '../components/account/AuthProvider';
import { MiniCart } from '../components/cart/MiniCart';
import { ShopProvider } from '../components/shop/ShopProvider';
import { loadLayout } from '../lib/api';
import { inter, playfair, tenor } from '../lib/fonts';
import { SITE_DESCRIPTION, SITE_NOINDEX, SITE_TITLE, SITE_URL } from '../lib/seo';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_TITLE, template: '%s | ArtQ' },
  description: SITE_DESCRIPTION,
  openGraph: { siteName: 'ArtQ', locale: 'en_IN', type: 'website', title: SITE_TITLE, description: SITE_DESCRIPTION },
  twitter: { card: 'summary_large_image' },
  // Staging and previews are never indexed (NEXT_PUBLIC_SEO_NOINDEX=1); robots.txt refuses crawlers there too.
  ...(SITE_NOINDEX ? { robots: { index: false, follow: false } } : {}),
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
        <AuthProvider>
          <ShopProvider>
            <AnnouncementBar enabled={settings.announcement.enabled} messages={settings.announcement.messages} />
            <Header navigation={navigation} />
            <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">{children}</main>
            <Footer navigation={navigation} settings={settings} />
            <WhatsAppButton number={settings.store.whatsapp} />
            <MiniCart />
            <SiteToaster />
          </ShopProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
