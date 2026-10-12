// ✅ Task 6.4 in a real browser against the real API (seed: scripts/e2e-storefront-seed.ts): robots.txt, the sitemap
// built from the API, a product page's canonical and JSON-LD, the home page's site data, the owner's search listing
// on the FAQ page, and an old shop address moved by proxy.ts (the visitor's query kept).
import { expect, test } from '@playwright/test';

test('robots.txt and the sitemap', async ({ request }) => {
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toMatch(/Disallow: \/checkout/);
  expect(robots).toMatch(/Sitemap: .+\/sitemap\.xml/);
  const xml = await (await request.get('/sitemap.xml')).text();
  expect(xml).toContain('/shop</loc>');
  expect(xml).toMatch(/\/product\/[a-z0-9-]+<\/loc>/);
  expect(xml).toMatch(/<image:loc>https?:\/\/[^<]+<\/image:loc>/);
  expect(xml).not.toContain('/checkout');
});

test('a product page: canonical, Open Graph and Product data; the home page: Organization and WebSite', async ({ page }) => {
  await page.goto('/shop');
  const first = page.locator('a[href^="/product/"]').first();
  const href = (await first.getAttribute('href'))!.split('?')[0]!;
  await page.goto(href);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`${href}$`));
  await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute('content', 'ArtQ');
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(ld.map((t) => JSON.parse(t)).flat().map((x: { '@type': string }) => x['@type'])).toEqual(expect.arrayContaining(['Product', 'BreadcrumbList']));
  await page.goto('/');
  const home = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((t) => JSON.parse(t)).flat();
  expect(home.map((x: { '@type': string }) => x['@type'])).toEqual(['Organization', 'WebSite']);
});

test('the owner’s search listing; an old address moves (query kept)', async ({ page }) => {
  await page.goto('/faqs');
  await expect(page).toHaveTitle('Resin art questions answered | ArtQ');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/faqs$/);
  const res = await page.request.get('/collections/e2e-resins?utm_source=old-site', { maxRedirects: 0 });
  expect(res.status()).toBe(301);
  expect(new URL(res.headers().location!, 'http://x').pathname + new URL(res.headers().location!, 'http://x').search).toBe('/shop?utm_source=old-site');
  await page.goto('/collections/e2e-resins');
  await expect(page).toHaveURL(/\/shop$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Shop all' })).toBeVisible();
});
