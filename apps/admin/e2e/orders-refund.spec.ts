// Task 5.4 against the real API and worker: a COD order is shipped and delivered (cash collected), refunded in part by
// bank transfer (the shared rules on the refund form, a recent password re-check), the transfer recorded, and the
// worker issues a credit note against the tax invoice, shown on the order.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1280, height: 900 } });

const API = join(import.meta.dirname, '..', '..', 'api');
const E2E_DATABASE_URL = `postgresql://artq:artq@localhost:${process.env.ARTQ_PG_PORT ?? '55432'}/artq_e2e`;

test('refund a delivered COD order by bank transfer; the credit note follows', async ({ page }) => {
  const made = JSON.parse(execFileSync('pnpm', ['--dir', API, 'exec', 'tsx', 'scripts/e2e-order.ts'], { env: { ...process.env, E2E_DATABASE_URL }, encoding: 'utf8' }).trim().split('\n').at(-1)!) as { orderNumber: string; id: number };
  await page.goto('/login');
  await page.getByLabel('Email').fill('owner@e2e.artq.in');
  await page.getByLabel('Password').fill('e2e-owner-passphrase');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(`/orders/${made.id}`);

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
  await ship.getByLabel('AWB / tracking number').fill(`RF-${made.orderNumber}`);
  await ship.getByRole('button', { name: 'Ship and issue invoice' }).click();
  await expect(page.getByLabel('Status')).toContainText('Shipped');
  await step('Mark delivered', 'Mark as delivered?');
  await expect(page.getByLabel('Status')).toContainText('COD: collected');

  await page.getByRole('button', { name: 'Refund', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Refund' });
  await dialog.getByRole('button', { name: /^Refund ₹/ }).click();
  await expect(dialog.getByLabel('Reason (kept on the refund)')).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByLabel('Amount: E2E Epoxy Resin').fill('499');
  await dialog.getByLabel('Units back: E2E Epoxy Resin').fill('1');
  await dialog.getByLabel('Reason (kept on the refund)').fill('One bottle arrived cracked');
  await axeClean(page);
  await dialog.getByRole('button', { name: 'Refund ₹499' }).click();
  // Refunds need a fresh password check: the dialog asks, then the same request goes through.
  await page.getByRole('dialog', { name: "Confirm it's you" }).or(page.getByRole('dialog', { name: 'Confirm it’s you' })).getByLabel('Password').fill('e2e-owner-passphrase');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText(/Refund #\d+ recorded\. Transfer ₹499/)).toBeVisible();

  const refunds = page.getByRole('region', { name: 'Refunds' });
  await refunds.getByRole('button', { name: 'Record transfer' }).click();
  const paid = page.getByRole('dialog', { name: /Record the transfer for refund/ });
  await paid.getByLabel('Bank / UPI reference').fill('UPI 998877');
  await paid.getByRole('button', { name: 'Mark paid' }).click();
  await expect(refunds).toContainText('Refunded');
  await expect(refunds).toContainText('Reference UPI 998877');
  await expect(page.getByLabel('Status')).toContainText('Partly refunded');

  // The worker issues the credit note against the invoice; it appears once the page is reloaded.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('region', { name: 'Shipment' })).toContainText(/CN\/\d{2}-\d{2}\/\d{6}/, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
});
