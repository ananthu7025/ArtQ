// ✅ Task 2.7 in the browser, against the real API and worker: the client's workbook becomes 64 draft products with
// 98 variants; the result file downloads.
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1440, height: 900 } });
const CLIENT_FILE = join(import.meta.dirname, '..', '..', '..', 'ArtQ_Product_Import_All_Items.xlsx');

test('import the client workbook: check, review, confirm, 64 drafts', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/login');
  await page.getByLabel('Email').fill('owner@e2e.artq.in');
  await page.getByLabel('Password').fill('e2e-owner-passphrase');
  await page.getByRole('button', { name: 'Log in' }).click();
  // Other specs share this e2e database: count what exists first.
  const counts = page.waitForResponse((r) => r.url().includes('/admin/product-types?withCounts=1') && r.ok());
  await page.getByRole('link', { name: 'Products', exact: true }).click();
  const before = ((await (await counts).json()) as { total: number }).total;
  const allTab = page.getByRole('group', { name: 'Product types' }).getByRole('button', { name: /^All/ });
  await page.getByRole('link', { name: 'Imports', exact: true }).click();

  await page.getByLabel('Workbook (.xlsx, up to 5 MB)').setInputFiles(CLIENT_FILE);
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByText('Checked: ready to import')).toBeVisible({ timeout: 60_000 });
  const summary = page.getByRole('region', { name: 'Summary' });
  await expect(summary).toContainText('Rows98');
  await expect(summary).toContainText('Products64');
  await page.getByRole('button', { name: 'With flags' }).click();
  await expect(page.getByRole('table', { name: 'Import rows' })).toContainText('Stock not a count');
  await axeClean(page);

  await page.getByRole('button', { name: 'Import 98 rows' }).click();
  await page.getByRole('dialog', { name: 'Import 98 rows?' }).getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(summary).toContainText('Created98');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Result file' }).click();
  expect((await download).suggestedFilename()).toMatch(/^catalog-import-\d+-result\.xlsx$/);

  await page.getByRole('link', { name: 'Products', exact: true }).click();
  await expect(allTab).toHaveText(`All ${before + 64}`);
  await page.getByLabel('Search name, SKU or slug').fill('TWF-05IN-8X10');
  await page.keyboard.press('Enter');
  const row = page.getByRole('row').filter({ hasText: 'Teak Wood Frame with Plywood Base' });
  await expect(row).toContainText('Wooden Frames');
  await expect(row).toContainText('Draft');
  await expect(page.locator('main')).not.toContainText(/unknown/i);
});
