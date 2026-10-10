// /robots.txt rules (task 6.4). Personal, transactional and token-bearing pages are kept out of crawls (they are also
// `noindex`); search results and filtered listings are crawlable but canonical to the base listing. Staging and preview
// sites (NEXT_PUBLIC_SEO_NOINDEX=1) refuse every crawler.
import type { MetadataRoute } from 'next';
import { SITE_NOINDEX, SITE_URL } from './seo';

/** Robots rules match by prefix, so '/account' also covers '/account/orders'. */
export const PRIVATE_PATHS = ['/account', '/cart', '/checkout', '/wishlist', '/login', '/signup', '/forgot-password', '/reset-password', '/set-password', '/track', '/newsletter'];

export function buildRobots(noindex = SITE_NOINDEX): MetadataRoute.Robots {
  if (noindex) return { rules: { userAgent: '*', disallow: '/' } };
  return { rules: { userAgent: '*', allow: '/', disallow: PRIVATE_PATHS }, sitemap: `${SITE_URL}/sitemap.xml`, host: SITE_URL };
}
