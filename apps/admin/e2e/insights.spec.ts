// Task 5.9 against the real API: the owner's dashboard (figures, chart and actions for a period), Customers (search
// finds a customer, the detail with the staff note saved) and Restock Requests (the page loads); all pass axe.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1280, height: 900 } });
const API = join(import.meta.dirname, '..', '..', 'api');
const E2E_DATABASE_URL = `postgresql://artq:artq@localhost:${process.env.ARTQ_PG_PORT ?? '55432'}/artq_e2e`;

test('dashboard, customers and restock requests', async ({ page }) => {
  const run = (script: string) => JSON.parse(execFileSync('pnpm', ['--dir', API, 'exec', 'tsx', `scripts/${script}`], { env: { ...process.env, E2E_DATABASE_URL }, encoding: 'utf8' }).trim().split('\n').at(-1)!);
  run('e2e-order.ts');
  const customer = run('e2e-customer.ts') as { id: number; email: string };
  await page.goto('/login');
  await page.getByLabel('Email').fill('owner@e2e.artq.in');
  await page.getByLabel('Password').fill('e2e-owner-passphrase');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Sales · 7 days' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Orders to confirm\s*[1-9]/ })).toBeVisible();
  await page.getByRole('button', { name: '30 days' }).click();
  await expect(page.getByRole('heading', { name: 'Sales · 30 days' })).toBeVisible();
  await axeClean(page);

  await page.getByRole('navigation').getByRole('link', { name: 'Customers' }).click();
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
  await page.getByLabel('Search').fill(customer.email);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('table', { name: 'Customers' }).getByRole('link', { name: 'Meera Customer' }).click();
  await expect(page.getByRole('heading', { name: 'Meera Customer' })).toBeVisible();
  await page.getByLabel('Not shown to the customer').fill('Prefers WhatsApp (e2e)');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('Note saved')).toBeVisible();
  await axeClean(page);

  await page.getByRole('navigation').getByRole('link', { name: 'Restock Requests' }).click();
  await expect(page.getByRole('heading', { name: 'Restock Requests' })).toBeVisible();
  await axeClean(page);
});
