// ✅ Task 3.4 in a real browser against the real API: ADD, quick add, Notify me, ♡ — the cart cookie set by the API
// host (:4001) is sent back from the storefront (:3100) and survives a reload.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function axeClean(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
const cartCount = (page: Page) => page.getByRole('banner').getByRole('link', { name: /^Cart, \d+ items?$/ });

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('ADD on a one-size card puts it in the cart; the count survives a reload (cart cookie)', async ({ page }) => {
    await page.goto('/');
    await expect(cartCount(page)).toHaveAccessibleName('Cart, 0 items');
    const add = page.getByRole('button', { name: /^Add .+ to cart$/ }).first();
    await add.click();
    await expect(page.getByText(/^Added .+ to your cart$/)).toBeVisible();
    await expect(cartCount(page)).toHaveAccessibleName('Cart, 1 item');
    await page.reload();
    await expect(cartCount(page)).toHaveAccessibleName('Cart, 1 item');
  });

  test('Options: the sheet loads sizes and live stock, adds the chosen size and quantity; axe clean', async ({ page }) => {
    await page.goto('/');
    const options = page.getByRole('button', { name: /^Options for / }).first();
    await options.click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('button', { name: /^Add to cart · ₹/ })).toBeVisible();
    await axeClean(page);
    await sheet.getByRole('button', { name: 'Increase quantity' }).click();
    await sheet.getByRole('button', { name: /^Add to cart · ₹/ }).click();
    await expect(sheet).toBeHidden();
    await expect(options).toBeFocused();
    await expect(page.getByText(/^Added 2 × .+ to your cart$/)).toBeVisible();
    await expect(cartCount(page)).toHaveAccessibleName('Cart, 2 items');   // each test starts with a fresh browser (no cart)
  });

  test('♡ saves to the wishlist; the header counts it; it is still saved after a reload', async ({ page }) => {
    await page.goto('/');
    const heart = page.getByRole('button', { name: /^Save .+ to wishlist$/ }).first();
    const label = (await heart.textContent())!;
    await heart.click();
    await expect(page.getByRole('link', { name: 'Wishlist, 1 item' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('link', { name: 'Wishlist, 1 item' })).toBeVisible();
    await expect(page.getByRole('button', { name: label.replace(/^Save /, 'Remove ').replace(/ to wishlist$/, ' from wishlist') }).first()).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('a sold-out size offers Notify me in a bottom sheet: the field error, then the confirmation from the API', async ({ page }) => {
    await page.goto('/');
    // The demo data sells out the last size of one product: find a card whose sheet shows a crossed-out option.
    const cards = page.getByRole('button', { name: /^(Options for|Notify me about) / });
    let found = false;
    for (let i = 0; i < (await cards.count()) && !found; i++) {
      await cards.nth(i).click();
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByText(/Loading options…/)).toBeHidden();
      const soldOut = sheet.getByRole('button', { name: /, sold out$/ }).first();
      if (await sheet.getByRole('button', { name: 'Notify me' }).count() === 0 && (await soldOut.count()) > 0) await soldOut.click();
      if (await sheet.getByRole('button', { name: 'Notify me' }).count() > 0) {
        found = true;
        const box = (await sheet.boundingBox())!;
        expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(843);   // a bottom sheet on phones
        await sheet.getByRole('button', { name: 'Notify me' }).click();
        await expect(sheet.getByLabel('Email address')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#notify-email-error')).toHaveText('Enter your email address');
        await expect(sheet.getByLabel('Email address')).toHaveCSS('border-top-color', 'rgb(185, 28, 28)');
        await sheet.getByLabel('Email address').fill(`maker-${Date.now()}@example.com`);
        await sheet.getByRole('button', { name: 'Notify me' }).click();
        await expect(sheet.getByRole('status')).toHaveText(/^We’ll email you when .+ is back in stock\.$/);
        await axeClean(page);
      } else {
        await page.keyboard.press('Escape');
      }
    }
    expect(found).toBe(true);
  });
});
