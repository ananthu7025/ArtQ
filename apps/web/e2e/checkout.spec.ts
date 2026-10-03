// ✅ Task 4.6 in a real browser against the real API: the checkout form validates with the shared rules (messages under
// the fields), the pincode fills in state and city, delivery and shipping come from POST /checkout/quote with the
// seeded Kerala rates, and cash on delivery adds its fee. Placing the order (POST /checkout/initiate) arrives with 4.7.
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
