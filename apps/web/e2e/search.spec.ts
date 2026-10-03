// ✅ Task 3.7 in a real browser against the real API (demo data): suggestions while typing (typo-tolerant, keyboard),
// the results page with filters, "Did you mean …", the empty search page; search pages are not indexed.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function axeClean(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('header search: a misspelling still suggests products; ↓ + Enter opens the highlighted product; axe clean', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('banner').getByRole('button', { name: 'Search' }).click();
    const box = page.getByRole('combobox', { name: 'Search products' });
    await expect(box).toBeFocused();
    await box.pressSequentially('resn');
    const list = page.getByRole('listbox', { name: 'Suggestions' });
    await expect(list.getByRole('option').first()).toBeVisible();
    await expect(list.getByRole('option').last()).toHaveText('See all results for “resn”');
    await axeClean(page);
    const first = (await list.getByRole('option').first().textContent())!;
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/product\//);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(first.replace(/₹[\d,]+$/, ''));
  });

  test('Enter searches: results page on the listing template; filters work inside a search; noindex', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('banner').getByRole('button', { name: 'Search' }).click();
    await page.getByRole('combobox', { name: 'Search products' }).fill('teak');
    await page.getByRole('dialog').getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(/\/search\?q=teak$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Results for “teak”');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.getByRole('main').getByRole('status').first()).toHaveText('2 products');
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('relevance');
    await page.getByRole('complementary', { name: 'Filters' }).getByRole('checkbox', { name: 'In stock only' }).check();
    await expect(page).toHaveURL(/q=teak&inStock=1/);
    await axeClean(page);
  });

  test('a misspelled search finds nothing but offers "Did you mean"; following it finds the product', async ({ page }) => {
    await page.goto('/search?q=butterfli');
    await expect(page.getByText('No products match “butterfli”')).toBeVisible();
    await page.getByRole('link', { name: 'Butterfly Frame' }).click();
    await expect(page).toHaveURL(/\/search\?q=Butterfly\+Frame$/);
    await expect(page.getByRole('main').locator('article')).toHaveCount(1);
  });

  test('/search without a query: the search box (focused) and the product types', async ({ page }) => {
    await page.goto('/search');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Search');
    await expect(page.getByRole('main').getByRole('combobox', { name: 'Search products' })).toBeFocused();
    await expect(page.getByRole('navigation', { name: 'Browse by type' }).getByRole('link', { name: 'Pigments' })).toBeVisible();
  });
});
