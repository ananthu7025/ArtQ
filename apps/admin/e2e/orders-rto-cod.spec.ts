// Task 5.6 against the real API: one COD order is shipped, comes back undelivered (RTO) and is received back (one unit
// restocked, one damaged; the order cancelled, cash not collected); another is delivered and the courier's payout is
// recorded for it, short by ₹10 (flagged), after which it leaves the waiting list.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1280, height: 900 } });

const API = join(import.meta.dirname, '..', '..', 'api');
const E2E_DATABASE_URL = `postgresql://artq:artq@localhost:${process.env.ARTQ_PG_PORT ?? '55432'}/artq_e2e`;
const newOrder = () => JSON.parse(execFileSync('pnpm', ['--dir', API, 'exec', 'tsx', 'scripts/e2e-order.ts'], { env: { ...process.env, E2E_DATABASE_URL }, encoding: 'utf8' }).trim().split('\n').at(-1)!) as { orderNumber: string; id: number };

async function shipIt(page: Page, o: { orderNumber: string; id: number }) {
  await page.goto(`/orders/${o.id}`);
  const step = async (button: string, dialog: string) => {
    await page.getByRole('button', { name: button, exact: true }).click();
    await page.getByRole('dialog', { name: dialog }).getByRole('button', { name: button, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };
  await step('Confirm order', 'Confirm this order?');
  await step('Mark packed', 'Mark as packed?');
  await page.getByRole('button', { name: 'Ship', exact: true }).click();
  const ship = page.getByRole('dialog', { name: 'Ship this order' });
  await ship.getByLabel('Courier').fill('DTDC');
  await ship.getByLabel('AWB / tracking number').fill(`RC-${o.orderNumber}`);
  await ship.getByRole('button', { name: 'Ship and issue invoice' }).click();
  await expect(page.getByLabel('Status')).toContainText('Shipped');
  return step;
}

test('RTO received back, and a courier payout recorded', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('owner@e2e.artq.in');
  await page.getByLabel('Password').fill('e2e-owner-passphrase');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // RTO.
  const rto = newOrder();
  const step = await shipIt(page, rto);
  await step('Returning to us', 'Is the parcel coming back to us?');
  await expect(page.getByLabel('Status')).toContainText('Returning to us');
  await page.getByRole('button', { name: 'Received back' }).click();
  const back = page.getByRole('dialog', { name: 'The parcel is back' });
  await back.getByLabel('Sellable: E2E Epoxy Resin').fill('1');
  await back.getByRole('button', { name: 'Restock and cancel order' }).click();
  await expect(back.getByLabel('Sellable: E2E Epoxy Resin')).toHaveAttribute('aria-invalid', 'true');   // one unit unaccounted for
  await back.getByLabel('Damaged: E2E Epoxy Resin').fill('1');
  await axeClean(page);
  await back.getByRole('button', { name: 'Restock and cancel order' }).click();
  await expect(page.getByLabel('Status')).toContainText('Cancelled');
  await expect(page.getByLabel('Status')).toContainText('COD: not collected');
  await expect(page.getByLabel('Status')).toContainText('Returned to us');

  // Delivered COD order → payout.
  const cod = newOrder();
  const step2 = await shipIt(page, cod);
  await step2('Mark delivered', 'Mark as delivered?');
  await page.goto('/cod-remittances');
  await expect(page.getByRole('link', { name: cod.orderNumber })).toBeVisible();
  await page.getByRole('button', { name: 'Record payout' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record a courier payout' });
  await dialog.getByRole('checkbox', { name: new RegExp(cod.orderNumber) }).check();
  await dialog.getByLabel(`Paid for ${cod.orderNumber}`).fill('1098');
  await dialog.getByLabel('Payout reference (UTR)').fill(`UTR-${cod.orderNumber}`);
  await dialog.getByLabel('Amount paid (₹)').fill('1098');
  await axeClean(page);
  await dialog.getByRole('button', { name: 'Record payout' }).click();
  await expect(page.getByText(`flagged: ${cod.orderNumber}`)).toBeVisible();
  await expect(page.getByRole('link', { name: cod.orderNumber })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Payouts' }).click();
  await expect(page.getByText(`UTR-${cod.orderNumber}`)).toBeVisible();
  await expect(page.getByText('(order total ₹1,108)').first()).toBeVisible();
  await page.goto(`/orders/${cod.id}`);
  await expect(page.getByLabel('Status')).toContainText('COD: remitted');
  await expect(page.getByText(/cod remittance mismatch/i)).toBeVisible();
});
