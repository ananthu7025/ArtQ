// ✅ Task 3.5 in a real browser against the real API (demo data): listing pages, filters in the URL, sort, price
// validation, empty state, type → category navigation, 404, the phone filter sheet. The same-variant rule itself
// ("Gold + in stock") is proven against the database in apps/api/test/integration/listing.test.ts.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function axeClean(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
const count = (page: Page) => page.getByRole('main').getByRole('status').first();
const prices = (page: Page) => page.locator('main article p').evaluateAll((ps) => ps.map((p) => Number((p.textContent ?? '').replace(/^From /, '').match(/₹([\d,]+)/)?.[1]?.replace(/,/g, '') ?? NaN)));

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Shop all: 12 live products, type chips, filters with counts; ticking one updates URL, count and chips; axe clean', async ({ page }) => {
    await page.goto('/shop');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Shop all');
    await expect(count(page)).toHaveText('12 products');
    await expect(page.getByRole('navigation', { name: 'Categories' }).getByRole('link', { name: 'Pigments' })).toHaveAttribute('href', '/type/pigments');
    await axeClean(page);
    const filters = page.getByRole('complementary', { name: 'Filters' });
    const pigments = filters.getByRole('group', { name: 'Product type' }).getByRole('checkbox', { name: /^Pigments, \d+ products?$/ });
    const n = Number((await pigments.getAttribute('aria-label'))!.match(/, (\d+) product/)![1]);
    await pigments.check();
    await expect(page).toHaveURL(/\/shop\?type=pigments$/);
    await expect(count(page)).toHaveText(n === 1 ? '1 product' : `${n} products`);
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('Pigments');
    await page.getByRole('list', { name: 'Active filters' }).getByRole('button', { name: 'Clear all' }).click();
    await expect(page).toHaveURL(/\/shop$/);
    await expect(count(page)).toHaveText('12 products');
  });

  test('sort by price, low to high: card prices ascend; the choice is in the URL and survives a reload', async ({ page }) => {
    await page.goto('/shop');
    await page.getByRole('combobox', { name: 'Sort by' }).selectOption('price_asc');
    await expect(page).toHaveURL(/sort=price_asc/);
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('price_asc');
    const p = await prices(page);
    expect(p.length).toBe(12);
    expect([...p].sort((a, b) => a - b)).toEqual(p);
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('price_asc');
  });

  test('price filter: max below min → red field + message; a valid range filters and shows a chip', async ({ page }) => {
    await page.goto('/shop');
    const filters = page.getByRole('complementary', { name: 'Filters' });
    await filters.getByLabel('Minimum').fill('500');
    await filters.getByLabel('Maximum').fill('100');
    await filters.getByRole('button', { name: 'Apply price' }).click();
    await expect(filters.getByLabel('Maximum')).toHaveAttribute('aria-invalid', 'true');
    await expect(filters.getByLabel('Maximum')).toHaveCSS('border-top-color', 'rgb(185, 28, 28)');
    await expect(filters.getByText('The maximum must be at least the minimum')).toBeVisible();
    await filters.getByLabel('Minimum').fill('100');
    await filters.getByLabel('Maximum').fill('500');
    await filters.getByRole('button', { name: 'Apply price' }).click();
    await expect(page).toHaveURL(/min=100&max=500/);
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('₹100 – ₹500');
    for (const price of await prices(page)) { expect(price).toBeGreaterThanOrEqual(100); expect(price).toBeLessThanOrEqual(500); }
  });

  test('nothing matches → empty state; Clear filters brings everything back', async ({ page }) => {
    await page.goto('/shop?size=no-such-size');
    await expect(page.getByText('No products match these filters')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(count(page)).toHaveText('12 products');
  });

  test('type page → category chip → category page with breadcrumb back to its type; unknown type → 404', async ({ page }) => {
    await page.goto('/type/pigments');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pigments');
    await expect(page.getByRole('complementary', { name: 'Filters' }).getByRole('group', { name: 'Product type' })).toHaveCount(0);
    const chip = page.getByRole('navigation', { name: 'Categories' }).getByRole('link').first();
    const name = (await chip.textContent())!;
    await chip.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs.getByRole('link', { name: 'Pigments' })).toHaveAttribute('href', '/type/pigments');
    await expect(crumbs.getByText(name)).toHaveAttribute('aria-current', 'page');
    await axeClean(page);
    const missing = await page.goto('/type/no-such-type');
    expect(missing!.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  });

  test('New Arrivals and Trending pages list the flagged products', async ({ page }) => {
    await page.goto('/new-arrivals');
    await expect(count(page)).toHaveText('5 products');
    await page.goto('/trending');
    await expect(count(page)).toHaveText('4 products');
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('filters in a bottom sheet; the button counts choices; no sideways scrolling; axe clean', async ({ page }) => {
    await page.goto('/shop');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect(page.getByRole('complementary', { name: 'Filters' })).toBeHidden();
    await page.getByRole('button', { name: 'Filters' }).click();
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    await sheet.getByRole('checkbox', { name: 'In stock only' }).check();
    await expect(page).toHaveURL(/inStock=1/);
    await expect(sheet.getByRole('button', { name: /^Show \d+ products?$/ })).toBeVisible();
    await axeClean(page);
    await sheet.getByRole('button', { name: /^Show \d+ products?$/ }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('button', { name: 'Filters, 1 chosen' })).toBeVisible();
  });
});
