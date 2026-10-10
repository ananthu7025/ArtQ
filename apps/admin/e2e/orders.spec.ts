// Task 5.1 against the real API: a placed COD order (made through the database functions) is found in the list,
// opened, its packing slip printed, the address corrected (a server field error shown on its field), confirmed and
// packed; after packing the address can no longer be edited; it is shipped (task 5.2) and its tax invoice PDF fetched
// through the signed link; the confirmation email is listed.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1280, height: 900 } });

const API = join(import.meta.dirname, '..', '..', 'api');
const E2E_DATABASE_URL = `postgresql://artq:artq@localhost:${process.env.ARTQ_PG_PORT ?? '55432'}/artq_e2e`;

test('orders: find, print the packing slip, correct the address, confirm, pack, ship and get the invoice', async ({ page }) => {
  const made = JSON.parse(execFileSync('pnpm', ['--dir', API, 'exec', 'tsx', 'scripts/e2e-order.ts'], { env: { ...process.env, E2E_DATABASE_URL }, encoding: 'utf8' }).trim().split('\n').at(-1)!) as { orderNumber: string; id: number };

  await page.goto('/login');
  await page.getByLabel('Email').fill('owner@e2e.artq.in');
  await page.getByLabel('Password').fill('e2e-owner-passphrase');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('link', { name: 'Orders', exact: true }).click();

  await page.getByLabel('Order, email, phone or name').fill(made.orderNumber);
  await page.getByLabel('Order, email, phone or name').press('Enter');
  const table = page.getByRole('table', { name: 'Orders' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table).toContainText('COD: to collect');
  await axeClean(page);
  await table.getByRole('link', { name: made.orderNumber }).click();

  await expect(page.getByRole('heading', { name: `Order ${made.orderNumber}` })).toBeVisible();
  await expect(page.getByText('Please call before delivery')).toBeVisible();
  // The packing slip is a real PDF from the API.
  const slip = page.waitForResponse((r) => r.url().endsWith(`/admin/orders/${made.id}/packing-slip`));
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Packing slip' }).click();
  const res = await slip;
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  expect(Number(res.headers()['content-length'])).toBeGreaterThan(1000);   // the bytes themselves are checked in the API test
  await (await popup).close();

  // Address correction: a pincode in another state is refused on the pincode field, then the right state saves.
  await page.getByRole('region', { name: 'Delivery address' }).getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Correct the delivery address' });
  await dialog.getByLabel('Pincode').fill('560001');
  await dialog.getByRole('button', { name: 'Save address' }).click();
  await expect(dialog.getByText('This pincode is in Karnataka')).toBeVisible();
  await expect(dialog.getByLabel('Pincode')).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByLabel('Pincode').fill('695001');   // no other spec gives this pincode a rule
  await dialog.getByLabel('City / town').fill('Thiruvananthapuram');
  await dialog.getByLabel('House / flat, building and street').fill('14 Rose Villa');
  await dialog.getByRole('button', { name: 'Save address' }).click();
  await expect(page.getByText('Thiruvananthapuram, Kerala 695001')).toBeVisible();

  await page.getByRole('button', { name: 'Confirm order' }).click();
  await page.getByRole('dialog', { name: 'Confirm this order?' }).getByRole('button', { name: 'Confirm order' }).click();
  await expect(page.getByRole('button', { name: 'Mark packed' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark packed' }).click();
  await page.getByRole('dialog', { name: 'Mark as packed?' }).getByRole('button', { name: 'Mark packed' }).click();
  await expect(page.getByLabel('Status')).toContainText('Packed');
  await expect(page.getByRole('region', { name: 'Delivery address' }).getByRole('button', { name: 'Edit' })).toHaveCount(0);
  const timeline = page.getByRole('region', { name: 'Timeline' });
  await expect(timeline).toContainText('Fulfilment: Packed');
  await expect(timeline).toContainText('Order: Confirmed');
  // Ship: the stock leaves, the tax invoice is issued; its PDF comes from private storage through a signed link.
  await page.getByRole('button', { name: 'Ship', exact: true }).click();
  const ship = page.getByRole('dialog', { name: 'Ship this order' });
  await ship.getByLabel('Courier').fill('DTDC');
  await ship.getByLabel('AWB / tracking number').fill(`E2E-${made.orderNumber}`);
  await ship.getByLabel('Tracking link (optional)').fill('http://not-secure.test');
  await ship.getByRole('button', { name: 'Ship and issue invoice' }).click();
  await expect(ship.getByLabel('Tracking link (optional)')).toHaveAttribute('aria-invalid', 'true');
  await ship.getByLabel('Tracking link (optional)').fill('');
  await ship.getByRole('button', { name: 'Ship and issue invoice' }).click();
  await expect(page.getByLabel('Status')).toContainText('Shipped');
  const shipment = page.getByRole('region', { name: 'Shipment' });
  await expect(shipment).toContainText(/AQ\/\d{2}-\d{2}\/\d{6}/);
  const link = page.waitForResponse((r) => r.url().endsWith(`/admin/orders/${made.id}/invoice`));
  const tab = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Invoice' }).click();
  const { url, number } = await (await link).json() as { url: string; number: string };
  await (await tab).close();
  expect(number).toMatch(/^AQ\/\d{2}-\d{2}\/\d{6}$/);
  const pdf = await page.request.get(url);
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

  // The worker really sends the confirmation; the page shows it once reloaded.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('region', { name: 'Emails' })).toContainText('Order confirmed', { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await axeClean(page);
});
