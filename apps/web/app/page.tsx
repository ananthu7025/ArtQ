// Home (product.md §5.1). Organization and WebSite data (with the site search) for search engines (task 6.4).
import type { Metadata } from 'next';
import { HomeSections } from '../components/home/HomeSections';
import { loadHome, loadLayout } from '../lib/api';
import { jsonLdScript, siteJsonLd, withSeo } from '../lib/seo';

export const revalidate = 60;

export function generateMetadata(): Promise<Metadata> {
  return withSeo('/', {});
}

export default async function HomePage() {
  const [{ home }, { settings }] = await Promise.all([loadHome(), loadLayout()]);
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(siteJsonLd(settings)) }} />
      <HomeSections home={home} />
    </>
  );
}
