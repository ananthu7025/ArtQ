// Task 5.5 against the real API: a COD order is shipped and delivered, the customer asks to return both bottles
// (photo attached), and staff take it through every step: approve, receive, inspect (one back in stock, one damaged),
// refund by bank transfer (a recent password re-check) and close; the order lists the closed return.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1280, height: 900 } });

const API = join(import.meta.dirname, '..', '..', 'api');
const E2E_DATABASE_URL = `postgresql://artq:artq@localhost:${process.env.ARTQ_PG_PORT ?? '55432'}/artq_e2e`;
const script = (name: string, ...args: string[]) => JSON.parse(execFileSync('pnpm', ['--dir', API, 'exec', 'tsx', `scripts/${name}`, ...args], { env: { ...process.env, E2E_DATABASE_URL }, encoding: 'utf8' }).trim().split('\n').at(-1)!);

test('a damaged-item return from request to refund and close', async ({ page }) => {
  const made = script('e2e-order.ts') as { orderNumber: string; id: number };
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
  await ship.getByLabel('AWB / tracking number').fill(`RT-${made.orderNumber}`);
  await ship.getByRole('button', { name: 'Ship and issue invoice' }).click();
  await expect(page.getByLabel('Status')).toContainText('Shipped');
  await step('Mark delivered', 'Mark as delivered?');

  const { returnId } = script('e2e-return.ts', String(made.id)) as { returnId: number };
  await page.goto('/returns');
  await page.getByRole('link', { name: `#${returnId} Arrived damaged` }).click();
  await expect(page.getByRole('heading', { name: `Return #${returnId}` })).toBeVisible();
  await expect(page.getByText('One bottle arrived cracked and leaking')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Customer photo 1' })).toHaveAttribute('src', /^http/);

  await page.getByRole('button', { name: 'Approve or reject' }).click();
  const decide = page.getByRole('dialog', { name: `Decide return #${returnId}` });
  await decide.getByLabel(/Units to accept/).fill('3');
  await decide.getByRole('button', { name: 'Approve return' }).click();
  await expect(decide.getByLabel(/Units to accept/)).toHaveAttribute('aria-invalid', 'true');      // more than asked: the server's answer on the field
  await decide.getByLabel(/Units to accept/).fill('2');
  await axeClean(page);
  await decide.getByRole('button', { name: 'Approve return' }).click();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await page.getByRole('dialog', { name: `Receive return #${returnId}` }).getByRole('button', { name: 'Mark received' }).click();
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  const inspect = page.getByRole('dialog', { name: `Inspect return #${returnId}` });
  await inspect.getByLabel('Sellable').fill('1');
  await inspect.getByLabel('Damaged').fill('1');
  await inspect.getByRole('button', { name: 'Save inspection' }).click();
  await expect(page.getByRole('region', { name: 'Items' })).toContainText('1 / 1');

  await page.getByRole('button', { name: 'Refund', exact: true }).click();
  const refund = page.getByRole('dialog', { name: `Refund return #${returnId}` });
  await expect(refund.getByLabel('Amount (₹)')).toHaveValue('998');
  await refund.getByRole('button', { name: 'Refund ₹998' }).click();
  await page.getByRole('dialog', { name: "Confirm it's you" }).or(page.getByRole('dialog', { name: 'Confirm it’s you' })).getByLabel('Password').fill('e2e-owner-passphrase');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText(/Refund #\d+ recorded\. Transfer ₹998/)).toBeVisible();
  await expect(page.getByText('Refunded', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('dialog', { name: `Close return #${returnId}?` }).getByRole('button', { name: 'Close return' }).click();
  await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible();

  await page.getByRole('link', { name: made.orderNumber }).click();
  const returns = page.getByRole('region', { name: 'Returns' });
  await expect(returns.getByRole('link', { name: `Return #${returnId}` })).toBeVisible();
  await expect(returns).toContainText('Closed');
  await expect(page.getByLabel('Status')).toContainText('Return closed');
});
