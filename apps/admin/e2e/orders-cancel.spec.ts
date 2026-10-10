// Task 5.3 against the real API: staff cancel a placed COD order with a reason; it is cancelled, the cash is no
// longer collected, the reason is in the timeline and the order offers no further steps.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1280, height: 900 } });

const API = join(import.meta.dirname, '..', '..', 'api');
const E2E_DATABASE_URL = `postgresql://artq:artq@localhost:${process.env.ARTQ_PG_PORT ?? '55432'}/artq_e2e`;

test('cancel an order: reason required, cancelled, COD not collected, reason in the timeline', async ({ page }) => {
  const made = JSON.parse(execFileSync('pnpm', ['--dir', API, 'exec', 'tsx', 'scripts/e2e-order.ts'], { env: { ...process.env, E2E_DATABASE_URL }, encoding: 'utf8' }).trim().split('\n').at(-1)!) as { orderNumber: string; id: number };
  await page.goto('/login');
  await page.getByLabel('Email').fill('owner@e2e.artq.in');
  await page.getByLabel('Password').fill('e2e-owner-passphrase');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);   // signed in before leaving the page
  await page.goto(`/orders/${made.id}`);

  await page.getByRole('button', { name: 'Cancel order' }).click();
  const dialog = page.getByRole('dialog', { name: `Cancel order ${made.orderNumber}?` });
  await expect(dialog).toContainText('Nothing was paid; the courier won’t collect anything.');
  await dialog.getByRole('button', { name: 'Cancel order' }).click();
  await expect(dialog.getByLabel('Reason (kept on the order)')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByText('Say why the order is cancelled')).toBeVisible();
  await axeClean(page);
  await dialog.getByLabel('Reason (kept on the order)').fill('Customer ordered twice');
  await dialog.getByRole('button', { name: 'Cancel order' }).click();

  const status = page.getByLabel('Status');
  await expect(status).toContainText('Cancelled');
  await expect(status).toContainText('COD: not collected');
  await expect(page.getByRole('region', { name: 'Timeline' })).toContainText('Customer ordered twice');
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm order' })).toHaveCount(0);
});
