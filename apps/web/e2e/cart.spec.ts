// ✅ Task 4.5 in a real browser against the real API: the mini-cart after an add, the cart page (quantity, remove +
// Undo, move to wishlist), a coupon (refused code under the field, then applied), the shipping estimate for a pincode
// with the seeded Kerala rates, and the empty state. Coupons: scripts/e2e-storefront-seed.ts.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function axeClean(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
const money = (s: string | null) => Number((s ?? '').replace(/[^\d.]/g, ''));

test.use({ viewport: { width: 1280, height: 900 } });

test('add → mini-cart → View cart; change quantity, coupon, shipping estimate, remove with Undo; axe clean', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Add .+ to cart$/ }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Added to your cart' });
  await expect(drawer.getByText('Cart subtotal (1 item)')).toBeVisible();
  await expect(drawer.getByText(/FREE shipping/)).toBeVisible();
  await axeClean(page);
  await drawer.getByRole('link', { name: 'View cart' }).click();

  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole('heading', { name: 'Your cart (1 item)' })).toBeVisible();
  const items = page.getByRole('list', { name: 'Items in your cart' });
  const more = items.getByRole('button', { name: /^One more / });
  await more.click();
  await expect(page.getByRole('heading', { name: 'Your cart (2 items)' })).toBeVisible();
  const summary = page.getByRole('region', { name: 'Order summary' });
  const subtotal = money(await summary.locator('dt', { hasText: /^Subtotal/ }).locator('xpath=following-sibling::dd').textContent());

  // A code that does not apply → its reason under the field; then the 10% coupon.
  const code = page.getByLabel('Coupon code');
  await code.fill('BULK500');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(code).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#coupon-code-error')).toHaveText(/^Add ₹.+ more of eligible items to use this coupon$/);
  await code.fill('welcome10');
  await code.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove coupon WELCOME10' })).toBeVisible();
  const discount = Math.min(Math.floor(subtotal * 10) / 100, 200);
  await expect(summary.getByText(/^Coupon WELCOME10/)).toBeVisible();
  expect(money(await summary.locator('dt', { hasText: /^Coupon/ }).locator('xpath=following-sibling::dd').textContent())).toBeCloseTo(discount, 2);

  // Shipping estimate for 682011 (Kerala, seeded slabs); remembered for the product page too.
  await page.getByLabel('Pincode').fill('682011');
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Delivery to 682011' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Delivery to 682011' }).getByRole('status')).toHaveText(/^(Shipping ₹\d+|Free shipping)/);
  await axeClean(page);

  // Remove with Undo.
  await items.getByRole('button', { name: /^Remove / }).click();
  await expect(page.getByText('Your cart is empty')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('heading', { name: 'Your cart (2 items)' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your cart (2 items)' })).toBeVisible();   // kept by the cart cookie
});

test('move to wishlist: out of the cart, into the wishlist', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Add .+ to cart$/ }).first().click();
  await page.getByRole('dialog', { name: 'Added to your cart' }).getByRole('link', { name: 'View cart' }).click();
  await page.getByRole('button', { name: /^Move .+ to your wishlist$/ }).click();
  await expect(page.getByText('Your cart is empty')).toBeVisible();
  await expect(page.getByRole('banner').getByRole('link', { name: 'Wishlist, 1 item' })).toBeVisible();
});
