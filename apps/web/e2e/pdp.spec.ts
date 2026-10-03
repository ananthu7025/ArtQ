// ✅ Task 3.6 in a real browser against the real API (demo data): the product page — live stock, options in the URL,
// add to cart, pincode check, gallery viewer, JSON-LD, WhatsApp pre-filled; phone: sticky add-to-cart, no sideways scroll.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function axeClean(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
/** A live product with several sizes, found through the listing API the page itself uses. */
async function multiSize(page: Page): Promise<string> {
  const res = await page.request.get('http://localhost:4001/v1/products?limit=24');
  const card = ((await res.json()) as { data: { slug: string; variantCount: number; inStock: boolean }[] }).data.find((c) => c.variantCount > 2 && c.inStock)!;
  return card.slug;
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('from a card to the product page: breadcrumb, live stock, JSON-LD, accordions; axe clean', async ({ page }) => {
    await page.goto('/');
    const link = page.locator('[data-section="new-arrivals"] article').first().getByRole('link');
    const name = (await link.textContent())!;
    await link.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Home' })).toBeVisible();
    await expect(page.getByText(/^(In stock|Only a few left|Out of stock)$/)).toBeVisible();
    await expect(page.getByText('Inclusive of all taxes')).toBeVisible();
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!) as { '@type': string; name: string; offers: { priceCurrency: string } }[];
    expect(ld[0]).toMatchObject({ '@type': 'Product', name, offers: { priceCurrency: 'INR' } });
    expect(ld[1]!['@type']).toBe('BreadcrumbList');
    await page.getByText('Shipping & returns').click();
    await expect(page.getByText(/Returns accepted within 48 hours of delivery/)).toBeVisible();
    await axeClean(page);
  });

  test('choosing a size puts it in the address; a reload keeps it; Add to cart updates the header', async ({ page }) => {
    await page.goto(`/product/${await multiSize(page)}`);
    await expect(page.getByText(/^(In stock|Only a few left)$/)).toBeVisible();
    const sizes = page.getByRole('group').filter({ hasText: /^Size/ }).getByRole('button');
    const other = sizes.filter({ hasNot: page.locator('[aria-pressed="true"]') }).and(page.locator('[aria-pressed="false"]')).first();
    await other.click();
    await expect(page).toHaveURL(/\?variant=/);
    const url = page.url();
    await page.reload();
    expect(page.url()).toBe(url);
    await expect(page.getByRole('group').filter({ hasText: /^Size/ }).locator('[aria-pressed="true"]')).toHaveCount(1);
    if (await page.getByRole('button', { name: 'Add to cart' }).isEnabled()) {
      await page.getByRole('button', { name: 'Add to cart' }).click();
      await expect(page.getByRole('dialog', { name: 'Added to your cart' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('banner').getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();
    }
  });

  test('pincode: a short number → field message; 682011 → delivers with COD; an unknown pincode → check the number', async ({ page }) => {
    await page.goto(`/product/${await multiSize(page)}`);
    const pin = page.getByLabel('Pincode');
    await pin.fill('6820');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(pin).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#pincode-error')).toHaveText('Enter a 6-digit pincode');
    await pin.fill('682011');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText('Delivers to Ernakulam, Kerala in 4–7 days. Cash on delivery available.')).toBeVisible();
    await pin.fill('999999');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText('We couldn’t find pincode 999999. Please check the number.')).toBeVisible();
  });

  test('gallery: the full-screen viewer opens, zooms and closes with Esc; WhatsApp starts with the product name', async ({ page }) => {
    await page.goto(`/product/${await multiSize(page)}`);
    const name = (await page.getByRole('heading', { level: 1 }).textContent())!;
    await page.getByRole('button', { name: /^Open photo 1 of \d+ full screen$/ }).click();
    const viewer = page.getByRole('dialog');
    await expect(viewer).toBeVisible();
    await viewer.getByRole('button', { name: 'Zoom in' }).click();
    await expect(viewer.getByRole('button', { name: 'Zoom out' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await expect(page.getByRole('link', { name: 'Chat with us on WhatsApp (opens WhatsApp)' })).toHaveAttribute('href', `https://wa.me/919847012345?text=${encodeURIComponent(`Hi ArtQ, I have a question about ${name}`)}`);
  });

  test('an unknown product → 404', async ({ page }) => {
    const res = await page.goto('/product/no-such-product');
    expect(res!.status()).toBe(404);
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('no sideways scroll; scrolling past the buttons shows a sticky add-to-cart bar; axe clean', async ({ page }) => {
    await page.goto(`/product/${await multiSize(page)}`);
    await expect(page.getByText(/^(In stock|Only a few left)$/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await axeClean(page);
    await page.getByText('Shipping & returns').scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 400);
    const bar = page.locator('div.fixed.bottom-0').filter({ has: page.getByRole('button', { name: 'Add to cart' }) });
    await expect(bar).toBeVisible();
  });
});
