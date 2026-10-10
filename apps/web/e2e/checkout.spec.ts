// ✅ Task 4.6 in a real browser against the real API: the checkout form validates with the shared rules (messages under
// the fields), the pincode fills in state and city, delivery and shipping come from POST /checkout/quote with the
// seeded Kerala rates, and cash on delivery adds its fee; then a real COD order is placed (task 4.7). The e2e API has no
// Razorpay keys, so paying online is off and the page offers cash on delivery.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function axeClean(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
const money = (s: string | null) => Number((s ?? '').replace(/[^\d.]/g, ''));
test.use({ viewport: { width: 1280, height: 900 } });

test('guest checkout: errors under the fields; pincode → place and delivery; shipping and the COD fee in the total; axe clean', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Add .+ to cart$/ }).first().click();
  await page.getByRole('dialog', { name: 'Added to your cart' }).getByRole('link', { name: 'Checkout' }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  const main = page.getByRole('main');
  const place = main.getByRole('button', { name: /^Place order · ₹/ });
  await place.click();
  await expect(main.getByLabel('Email', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(main.getByText('Enter a 10-digit mobile number')).toBeVisible();
  await expect(main.getByText('Accept the terms to place your order')).toBeVisible();
  await axeClean(page);

  await main.getByLabel('Pincode').fill('682011');
  await expect(main.getByLabel('City / town')).toHaveValue('Ernakulam');
  await expect(main.getByLabel('State').locator('option:checked')).toHaveText('Kerala');
  await expect(main.getByText(/^We deliver here/)).toBeVisible();
  const total = async () => money(await main.locator('dt', { hasText: /^Total$/ }).locator('xpath=following-sibling::dd').textContent());
  const online = await total();
  await expect(main.locator('p', { hasText: /^Shipping: / })).toHaveText(/^Shipping: (₹\d+|Free)/);
  const cod = main.getByLabel(/^Cash on delivery/);
  await expect(cod).toBeEnabled();
  await cod.check();
  await expect.poll(total).toBe(online + 40);   // the seeded ₹40 COD fee
  await expect(place).toHaveText(`Place order · ₹${(online + 40).toLocaleString('en-IN')}`);
  await axeClean(page);
});

test('guest places a cash-on-delivery order: confirmation page, the cart is empty afterwards', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Add .+ to cart$/ }).first().click();
  await page.getByRole('dialog', { name: 'Added to your cart' }).getByRole('link', { name: 'Checkout' }).click();
  const main = page.getByRole('main');
  await main.getByLabel('Email', { exact: true }).fill(`e2e-cod-${Date.now()}@example.com`);
  await main.getByLabel('Mobile number').fill('98470 12345');
  await main.getByLabel('Full name').fill('Hema R');
  await main.getByLabel('Phone for delivery').fill('9847012345');
  await main.getByLabel('Pincode').fill('682011');
  await expect(main.getByLabel('City / town')).toHaveValue('Ernakulam');
  await main.getByLabel('House / flat, building and street').fill('12 Rose Villa');
  await expect(main.getByText(/^We deliver here/)).toBeVisible();
  await expect(main.getByLabel(/^Pay online/)).toBeDisabled();             // no Razorpay keys in e2e
  await expect(main.getByLabel(/^Cash on delivery/)).toBeChecked();
  await main.getByLabel(/I agree to the/).check();
  await main.getByRole('button', { name: /^Place order · ₹/ }).click();
  await expect(page).toHaveURL(/\/checkout\/success\/AQ\d+$/);
  await expect(page.getByRole('heading', { name: 'Thank you, Hema! Your order is placed.' })).toBeVisible();
  await expect(page.getByText(/^Cash on delivery: please keep ₹[\d,]+ ready\.$/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Delivering to' })).toContainText('12 Rose Villa');
  await page.getByRole('button', { name: 'Set a password' }).click();
  await expect(page.getByText(/^Link sent\. Check your inbox/)).toBeVisible();
  await expect(page.getByRole('banner').getByRole('link', { name: /^Cart, \d+ items?$/ })).toHaveAccessibleName('Cart, 0 items');
  await axeClean(page);
});
