// ✅ Task 2.8 in the browser, against the real API and worker: a small catalogue import brings in uncounted stock; the
// Inventory page counts one variant (with the API's validation shown on the field), the count sheet is downloaded,
// filled in and imported back through the worker, and STAFF can count stock but never start a catalogue import.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1440, height: 900 } });

// exceljs comes from the API package (the admin app itself never reads workbooks).
type Sheet = { addRow(v: unknown[]): void; eachRow(cb: (row: { getCell(c: number): { value: unknown } }, n: number) => void): void };
type Book = { addWorksheet(n: string): Sheet; getWorksheet(n: string): Sheet | undefined; xlsx: { load(b: Buffer): Promise<unknown>; writeBuffer(): Promise<ArrayBuffer> } };
const ExcelJS = createRequire(join(import.meta.dirname, '..', '..', 'api', 'package.json'))('exceljs') as { Workbook: new () => Book };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SKU_A = 'INVE2E-PIGMENT-RED', SKU_B = 'INVE2E-PIGMENT-BLUE';

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('sidebar')).toBeVisible();
}
async function importFile(page: Page, name: string, buffer: Buffer) {
  await page.getByLabel('Workbook (.xlsx, up to 5 MB)').setInputFiles({ name, mimeType: XLSX, buffer });
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByText('Checked: ready to import')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Import \d+ rows$/ }).click();
  await page.getByRole('dialog', { name: /^Import \d+ rows\?$/ }).getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 90_000 });
}
const stockRow = (page: Page, sku: string) => page.getByRole('table', { name: 'Stock' }).getByRole('row').filter({ hasText: sku });

test('count, adjust, download the count sheet and import counts back; STAFF counts but cannot import the catalogue', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, 'owner@e2e.artq.in', 'e2e-owner-passphrase');

  // 1. Two variants arrive by catalogue import: stock 12 and 3, not counted yet.
  const cat = new ExcelJS.Workbook();
  const ws = cat.addWorksheet('2. Products & Variants');
  ws.addRow(['Category (Type) *', 'Subcategory *', 'Product Name *', 'Size / Volume *', 'Selling Price (₹) *', 'Stock Quantity *', 'SKU']);
  ws.addRow(['Pigments', 'Mica Powder', 'Inventory Demo Mica Pigment', '10 g Red', 149, 12, SKU_A]);
  ws.addRow(['Pigments', 'Mica Powder', 'Inventory Demo Mica Pigment', '10 g Blue', 149, 3, SKU_B]);
  await page.getByRole('link', { name: 'Imports', exact: true }).click();
  await page.getByRole('radio', { name: /Catalogue/ }).check();
  await importFile(page, 'inventory-demo-catalogue.xlsx', Buffer.from(await cat.xlsx.writeBuffer()));

  // 2. The Inventory page: both uncounted; 3 ≤ the low-stock threshold.
  await page.getByRole('link', { name: 'Inventory', exact: true }).click();
  await page.getByLabel('Search SKU or product').fill('INVE2E');
  await page.keyboard.press('Enter');
  await expect(stockRow(page, SKU_A)).toContainText('Not counted');
  await expect(stockRow(page, SKU_B)).toContainText('Not counted');
  await axeClean(page);

  // 3. Write off damaged units: the reason is required (red border + message from the shared schema), then saved.
  await stockRow(page, SKU_A).getByRole('button', { name: `Change stock of ${SKU_A}` }).click();
  const dlg = page.getByRole('dialog', { name: `Change stock: ${SKU_A}` });
  await dlg.getByLabel('Write off damaged').check();
  await dlg.getByLabel('Units to write off').fill('2');
  await expect(dlg.getByRole('status')).toHaveText('On hand 12 → 10');
  await dlg.getByRole('button', { name: 'Save' }).click();
  const reason = dlg.getByLabel('Reason');
  await expect(reason).toHaveAttribute('aria-invalid', 'true');
  await expect(dlg.getByText('Give a reason')).toBeVisible();
  await expect(reason).toHaveCSS('border-top-color', 'rgb(185, 28, 28)');   // --color-danger-700
  await axeClean(page);
  await reason.fill('Jar cracked in transit');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`${SKU_A} updated`)).toBeVisible();
  await expect(stockRow(page, SKU_A)).toContainText('10');

  // 4. The ledger shows both movements.
  await stockRow(page, SKU_A).getByRole('button', { name: `Stock history of ${SKU_A}` }).click();
  const history = page.getByRole('dialog', { name: `Stock history: ${SKU_A}` });
  await expect(history.getByRole('table', { name: 'Stock movements' })).toContainText('Damaged / written off');
  await expect(history.getByRole('table', { name: 'Stock movements' })).toContainText('Jar cracked in transit');
  await expect(history.getByRole('table', { name: 'Stock movements' })).toContainText('Imported (uncounted)');
  await page.keyboard.press('Escape');

  // 5. Download the count sheet, count 9 red and 0 blue, import it back.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download count sheet' }).click();
  const sheet = new ExcelJS.Workbook();
  await sheet.xlsx.load(await readFile((await (await download).path())));
  const counts = sheet.getWorksheet('Stock count')!;
  const filled = new ExcelJS.Workbook();
  const out = filled.addWorksheet('Stock count');
  counts.eachRow((row, n) => {
    const cells = [1, 2, 3, 4, 5, 6, 7].map((c) => row.getCell(c).value);
    if (n > 1 && cells[0] === SKU_A) cells[4] = 9;
    if (n > 1 && cells[0] === SKU_B) cells[4] = 0;
    out.addRow(cells);
  });
  await page.getByRole('link', { name: /Import counts/ }).click();
  await expect(page.getByRole('heading', { name: 'Import stock counts' })).toBeVisible();
  await importFile(page, 'stock-count.xlsx', Buffer.from(await filled.xlsx.writeBuffer()));
  await expect(page.getByRole('region', { name: 'Summary' })).toContainText('Counted2');

  // 6. Counted now; blue is out of stock.
  await page.getByRole('link', { name: 'Inventory', exact: true }).click();
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Out of stock' }).click();
  await page.getByLabel('Search SKU or product').fill('INVE2E');
  await page.keyboard.press('Enter');
  await expect(stockRow(page, SKU_B)).toBeVisible();
  await expect(stockRow(page, SKU_B)).not.toContainText('Not counted');
  await expect(stockRow(page, SKU_A)).toHaveCount(0);

  // 7. STAFF: stock counts yes, catalogue no.
  await page.getByRole('button', { name: /Log out/ }).click();
  await login(page, 'staff@e2e.artq.in', 'e2e-staff-passphrase');
  await page.getByRole('link', { name: 'Imports', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import stock counts' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Catalogue/ })).toHaveCount(0);
  await expect(page.getByRole('table')).not.toContainText('inventory-demo-catalogue.xlsx');
  await expect(page.getByRole('table')).toContainText('stock-count.xlsx');
});
