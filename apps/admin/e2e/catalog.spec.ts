// Products page (task 2.4) and Audit Logs through the real API, in one owner session.
import { expect, test } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();

const OWNER = { email: 'owner@e2e.artq.in', password: 'e2e-owner-passphrase' };

test.use({ viewport: { width: 1280, height: 720 } });

test('owner: brand fonts, add a product, gate refusal on the toggle, then Audit Logs', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Self-hosted brand fonts are loaded and used.
  expect(await page.evaluate(async () => { await document.fonts.ready; return [document.fonts.check('16px "Inter Variable"'), document.fonts.check('24px "Playfair Display Variable"')]; })).toEqual([true, true]);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"Inter Variable"/);

  await page.getByRole('link', { name: 'Products', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible();
  await expect(page.getByText('No products match.')).toBeVisible();

  // Add product: the validation rule (red border + message), then a draft that opens its page.
  await page.getByRole('button', { name: 'Add product' }).click();
  const add = page.getByRole('dialog', { name: 'Add product' });
  await add.getByRole('button', { name: 'Create draft' }).click();
  await expect(add.getByLabel('Name')).toHaveCSS('border-top-color', 'rgb(185, 28, 28)');
  await expect(add.locator('#product-name-error')).toHaveText('Enter a product name');
  await add.getByLabel('Name').fill('E2E Resin Starter Kit');
  await add.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'E2E Resin Starter Kit' })).toBeVisible();
  await expect(page.getByText('Type & category:')).toBeVisible();

  // Back on the list: Unassigned (never "Unknown"), the missing image state, and the gate on the toggle.
  await page.getByRole('link', { name: 'All products' }).click();
  const row = page.getByRole('row').filter({ hasText: 'E2E Resin Starter Kit' });
  await expect(row).toContainText('Unassigned');
  await expect(page.locator('main')).not.toContainText(/unknown/i);
  await expect(row.locator('[data-image-state="MISSING"]')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Product types' }).getByRole('button', { name: /Unassigned/ })).toContainText('1');
  await axeClean(page);
  await row.getByRole('switch', { name: 'Publish E2E Resin Starter Kit' }).click();
  const pop = page.getByRole('alertdialog', { name: 'E2E Resin Starter Kit cannot be published yet' });
  await expect(pop).toContainText('Type & category');
  await expect(pop).toContainText('Description');
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');

  await row.getByRole('button', { name: 'Variants of E2E Resin Starter Kit' }).click();
  await expect(page.getByRole('dialog', { name: 'Variants of E2E Resin Starter Kit' })).toContainText('No variants yet');
  await page.keyboard.press('Escape');

  // Delete the fresh draft (offered because it was never used), confirming with its name.
  await row.getByRole('button', { name: 'More actions for E2E Resin Starter Kit' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete “E2E Resin Starter Kit”?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('No products match.')).toBeVisible();

  // Audit Logs lists this run's logins and the catalogue changes.
  await page.goto('/audit-logs?action=product.');
  await expect(page.getByRole('cell', { name: 'product.create' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'product.delete' })).toBeVisible();
  await page.goto('/audit-logs?action=admin.login');
  await expect(page.getByRole('cell', { name: 'admin.login' }).first()).toBeVisible();
  await expect(page.getByText(/Page 1 of \d+ · \d+ total/)).toBeVisible();
  await axeClean(page);
});
