// ✅ Task 6.5 end to end against the real API: the owner changes the return window (password re-check), finds the
// change in the Audit Logs with its before and after, and exports the filtered log as CSV; then puts the window back
// (the returns spec relies on the launch value).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
const OWNER = { email: 'owner@e2e.artq.in', password: 'e2e-owner-passphrase' };

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Log in' }).click();
}
async function setReturnWindow(page: Page, hours: string) {
  const returns = page.getByRole('region', { name: 'Returns' });
  await returns.getByLabel('Return window (hours after delivery)').fill(hours);
  await returns.getByRole('button', { name: 'Save return window' }).click();
  const confirm = page.getByRole('dialog', { name: /Confirm it.s you/ });
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Confirm' }).click();
  }
  await expect(page.getByText('Return window saved').last()).toBeVisible();
}

test('settings saved after the password → the change in the audit log, before and after → CSV export', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  const returns = page.getByRole('region', { name: 'Returns' });
  await expect(returns.getByLabel('Return window (hours after delivery)')).toHaveValue('48');
  await axeClean(page);
  await returns.getByLabel('Return window (hours after delivery)').fill('721');
  await returns.getByRole('button', { name: 'Save return window' }).click();
  await expect(returns.getByText('At most 720 hours (30 days)')).toBeVisible();
  await returns.getByLabel('Return window (hours after delivery)').fill('72');
  await returns.getByRole('button', { name: 'Save return window' }).click();
  await page.getByRole('dialog', { name: /Confirm it.s you/ }).getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Return window saved')).toBeVisible();
  await expect(returns.getByText(/^Changed .+ by /)).toBeVisible();

  await page.getByRole('link', { name: 'Audit Logs' }).click();
  await page.getByLabel('Record type').selectOption('setting');
  await page.getByLabel('Record id').fill('ORDER');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('button', { name: /^Open entry \d+: setting\.update$/ }).first().click();
  const entry = page.getByRole('dialog', { name: /^Audit entry #\d+$/ });
  await expect(entry.getByRole('row').filter({ hasText: 'returnWindowHours' })).toContainText('Before: 48');
  await expect(entry.getByRole('row').filter({ hasText: 'returnWindowHours' })).toContainText('After: 72');
  await axeClean(page);
  await entry.getByRole('button', { name: 'Close' }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();   // the password was entered moments ago
  const file = await (await download).path();
  const csv = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  expect(csv.split('\r\n')[0]).toBe('"id","created_at","actor_email","actor_name","action","entity","entity_id","ip","before","after"');
  expect(csv).toContain('"owner@e2e.artq.in"');
  expect(csv).toContain('"setting.update","setting","ORDER"');

  await page.getByRole('link', { name: 'Settings' }).click();
  await setReturnWindow(page, '48');
});
