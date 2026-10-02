// ✅ Task 2.5: recreate "Teak Wood Frame" (14 variants, catalog.md P4) in the real editor against the real API in < 5 min.
// Its own name and SKU prefix, so the import spec (which imports the real catalogue in the same e2e database) never collides.
import { expect, test } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });

const OWNER = { email: 'owner@e2e.artq.in', password: 'e2e-owner-passphrase' };
// catalog.md P4, in the sheet's order: 8 sizes at 1 inch, then 6 at 0.5 inch.
const ONE_INCH = ['4x6', '6x6', '8x8', '10x10', '9x12', '12x12', '12x16', '14x14'];
const HALF_INCH = ['4x6', '6x6', '8x8', '8x10', '10x10', '9x12'];
const PRICES = [210, 299, 360, 399, 470, 500, 640, 680, 190, 270, 350, 399, 380, 460];
// 1×1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('Teak Wood Frame with 14 variants, prices, description and an image, in under 5 minutes', async ({ page }) => {
  const started = Date.now();
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('link', { name: 'Products', exact: true }).click();

  await page.getByRole('button', { name: 'Add product' }).click();
  await page.getByRole('dialog', { name: 'Add product' }).getByLabel('Name').fill('Editor Demo Teak Frame');
  await page.getByRole('dialog', { name: 'Add product' }).getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Editor Demo Teak Frame' })).toBeVisible();

  // Content: rich-text description (real ProseMirror typing), details, care.
  const description = page.getByRole('textbox', { name: 'Description', exact: true });
  await description.click();
  await page.keyboard.type('Teak wood frames with plywood base, suitable for photo framing, resin art and preservation projects.');
  await page.getByRole('button', { name: 'Bold' }).click();
  await page.keyboard.type(' Natural teak finish.');
  await page.getByLabel('Product details (one per line)').fill('Teak wood frame\nPlywood base\nSmooth finished frame\nSuitable for resin art and photo projects');
  await page.getByLabel('Specifications & care (one per line)').fill('Keep away from prolonged moisture\nClean with a soft dry cloth\nStore in a dry place');
  await page.getByRole('button', { name: 'Save product' }).click();
  await expect(page.getByText('Product saved').first()).toBeVisible();

  // Variants: two "Generate" runs, then one paste for the whole price column.
  for (const [sizes, depth] of [[ONE_INCH, '1 inch'], [HALF_INCH, '0.5 inch']] as const) {
    await page.getByRole('button', { name: 'Generate variants' }).click();
    const dlg = page.getByRole('dialog', { name: 'Generate variants' });
    await dlg.getByLabel('SKU prefix').fill('EDT');
    await dlg.getByLabel('Sizes (comma-separated)').fill(sizes.join(', '));
    await dlg.getByLabel('Option values (comma-separated)').fill(depth);
    await dlg.getByRole('button', { name: `Add ${sizes.length} rows` }).click();
  }
  await expect(page.getByText('14 unsaved rows')).toBeVisible();
  await page.evaluate((text) => navigator.clipboard.writeText(text), PRICES.join('\n'));
  await page.getByLabel('Price (₹), row 1', { exact: true }).click();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(page.getByLabel('Price (₹), row 14', { exact: true })).toHaveValue('460');
  await page.getByRole('button', { name: 'Save variants' }).click();
  await expect(page.getByText('14 variants saved').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('All variants saved')).toBeVisible();

  // Media: the real presign → storage PUT → complete path.
  await page.getByLabel('Upload images').setInputFiles({ name: 'teak-frame.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('Image added').first()).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Use image 1 as the cover' })).toBeChecked();   // the first upload becomes the cover

  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(5 * 60_000);
  test.info().annotations.push({ type: 'elapsed', description: `${Math.round(elapsed / 1000)} s` });

  // What was saved, read back from the server: SKUs in the catalogue format, generated labels, prices in paise.
  await page.reload();
  await expect(page.getByLabel('SKU, row 1', { exact: true })).toHaveValue('EDT-1IN-4X6');
  await expect(page.getByLabel('SKU, row 12', { exact: true })).toHaveValue('EDT-05IN-8X10');
  await expect(page.getByLabel('Label, row 1', { exact: true })).toHaveValue('4×6 in / 1 inch');
  await expect(page.getByLabel('Price (₹), row 9', { exact: true })).toHaveValue('190');
  await expect(page.getByRole('textbox', { name: 'Description', exact: true }).locator('strong')).toHaveText('Natural teak finish.');
  await expect(page.getByRole('region', { name: 'Ready to publish?' })).toContainText('Tax classification');
  await axeClean(page);

  await page.getByRole('link', { name: 'All products' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Editor Demo Teak Frame' });
  await expect(row).toContainText('₹190–₹680');
  await expect(row.getByRole('cell').nth(8)).toHaveText('14');   // cells: select, #, image, name, type, price, available, status, variants
});
