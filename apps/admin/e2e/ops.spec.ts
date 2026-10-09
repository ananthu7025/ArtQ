// Task 5.8 against the real API and worker: the owner (super admin) opens Payment Exceptions and Jobs & Webhooks; a
// payment exception raised by the database (a COD payout paid short) is listed, explained and resolved with a note;
// the jobs page shows the queues and scheduled jobs; both pages pass axe.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1280, height: 900 } });
const API = join(import.meta.dirname, '..', '..', 'api');
const E2E_DATABASE_URL = `postgresql://artq:artq@localhost:${process.env.ARTQ_PG_PORT ?? '55432'}/artq_e2e`;

test('payment exceptions resolved with a note; jobs & webhooks health', async ({ page }) => {
  const made = JSON.parse(execFileSync('pnpm', ['--dir', API, 'exec', 'tsx', 'scripts/e2e-order.ts'], { env: { ...process.env, E2E_DATABASE_URL }, encoding: 'utf8' }).trim().split('\n').at(-1)!) as { orderNumber: string; id: number };
  await page.goto('/login');
  await page.getByLabel('Email').fill('owner@e2e.artq.in');
  await page.getByLabel('Password').fill('e2e-owner-passphrase');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Deliver the COD order and record a short payout: the database raises COD_REMITTANCE_MISMATCH.
  await page.goto(`/orders/${made.id}`);
  for (const [button, dialog] of [['Confirm order', 'Confirm this order?'], ['Mark packed', 'Mark as packed?']] as const) {
    await page.getByRole('button', { name: button, exact: true }).click();
    await page.getByRole('dialog', { name: dialog }).getByRole('button', { name: button, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Ship', exact: true }).click();
  const ship = page.getByRole('dialog', { name: 'Ship this order' });
  await ship.getByLabel('Courier').fill('DTDC');
  await ship.getByLabel('AWB / tracking number').fill(`OPS-${made.orderNumber}`);
  await ship.getByRole('button', { name: 'Ship and issue invoice' }).click();
  await page.getByRole('button', { name: 'Mark delivered', exact: true }).click();
  await page.getByRole('dialog', { name: 'Mark as delivered?' }).getByRole('button', { name: 'Mark delivered', exact: true }).click();
  await page.goto('/cod-remittances');
  await page.getByRole('button', { name: 'Record payout' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record a courier payout' });
  await dialog.getByRole('checkbox', { name: new RegExp(made.orderNumber) }).check();
  await dialog.getByLabel(`Paid for ${made.orderNumber}`).fill('1100');
  await dialog.getByLabel('Payout reference (UTR)').fill(`UTR-OPS-${made.orderNumber}`);
  await dialog.getByLabel('Amount paid (₹)').fill('1100');
  await dialog.getByRole('button', { name: 'Record payout' }).click();
  await expect(page.getByText(`flagged: ${made.orderNumber}`)).toBeVisible();

  await page.goto('/payment-exceptions');
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: made.orderNumber }) });
  await expect(row).toContainText('Courier paid a different amount');
  await axeClean(page);
  await row.getByRole('button', { name: /^Resolve exception/ }).click();
  const close = page.getByRole('dialog', { name: 'Resolve this exception' });
  await close.getByRole('button', { name: 'Resolve' }).click();
  await expect(close.getByLabel('What did you do?')).toHaveAttribute('aria-invalid', 'true');
  await close.getByLabel('What did you do?').fill('Courier deducted ₹8 handling; agreed by phone');
  await close.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('Exception resolved')).toBeVisible();
  await expect(page.getByRole('link', { name: made.orderNumber })).toHaveCount(0);

  await page.goto('/jobs');
  await expect(page.getByRole('table', { name: 'Queue depths' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scheduled jobs' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Razorpay notifications' })).toBeVisible();
  await axeClean(page);
});
