// Task 4.4a against the real API: Delivery areas shows every known pincode (the 16-row postal sample) with what checkout
// does there, the default delivery is edited in place, and a rule for a pincode outside the directory is flagged.
import { expect, test } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1280, height: 800 } });

test('delivery areas: coverage, rules from the list, the default policy, rules outside the directory', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('owner@e2e.artq.in');
  await page.getByLabel('Password').fill('e2e-owner-passphrase');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('link', { name: 'Shipping Rates', exact: true }).click();
  await page.getByRole('tab', { name: 'Delivery areas' }).click();

  const coverage = page.getByRole('region', { name: 'Coverage' });
  await expect(coverage.getByText('Known pincodes').locator('xpath=following-sibling::dd')).toHaveText('16');
  await expect(coverage.getByRole('button', { name: 'Delivered: 16. Show them' })).toBeVisible();
  await expect(coverage.getByRole('button', { name: 'Air-only: 2. Show them' })).toBeVisible();   // Port Blair (744…), Kavaratti (68255…)
  const table = page.getByRole('table', { name: 'Pincodes' });
  await expect(table.getByRole('row')).toHaveCount(17);
  await axeClean(page);

  // Search by office name, then give that pincode its own rule from its row.
  await page.getByLabel('Pincode or place').fill('kadavanthra');
  await page.getByLabel('Pincode or place').press('Enter');
  await expect(table.getByRole('row')).toHaveCount(2);
  await table.getByRole('button', { name: 'Add a rule for 682020' }).click();
  const rule = page.getByRole('dialog', { name: 'Pincode 682020' });
  await rule.getByLabel('Cash on delivery available').uncheck();
  await rule.getByLabel('Note (staff only, optional)').fill('Prepaid only for now');
  await rule.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('682020 saved')).toBeVisible();
  const row = table.getByRole('row').filter({ hasText: '682020' });
  await expect(row).toContainText('Prepaid only');
  await expect(row).toContainText('Own rule');
  await expect(coverage.getByRole('button', { name: 'Prepaid only: 1. Show them' })).toBeVisible();

  // A rule for a pincode the directory doesn't know: saved with a warning, and the summary says so.
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add a pincode rule' });
  await add.getByLabel('Pincode').fill('695009');
  await add.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('695009 saved, but it isn’t in the postal directory, so checkout can’t charge shipping there.')).toBeVisible();
  await expect(coverage.getByRole('alert')).toContainText('1 rule is for pincodes missing from the postal directory');
  await coverage.getByRole('button', { name: 'Show them', exact: true }).click();
  await expect(page.getByLabel('Show', { exact: true })).toHaveValue('unknown');
  await expect(table.getByRole('row').filter({ hasText: '695009' })).toContainText('Not in postal directory');
  await table.getByRole('button', { name: 'Remove the rule for 695009' }).click();
  await page.getByRole('dialog', { name: 'Remove the rule for 695009?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(coverage.getByRole('alert')).toHaveCount(0);

  // The default policy, edited in place: COD off everywhere without a rule.
  const def = page.getByRole('region', { name: 'Every other pincode' });
  await def.getByRole('button', { name: 'Edit default' }).click();
  const dialog = page.getByRole('dialog', { name: 'Default delivery' });
  await dialog.getByLabel('Usual delivery: to (days)').fill('2');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Use at least the minimum')).toBeVisible();
  await dialog.getByLabel('Usual delivery: to (days)').fill('7');
  await dialog.getByLabel('Cash on delivery wherever we deliver').uncheck();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(def).toContainText('Delivered, prepaid only');
  await expect(coverage.getByRole('button', { name: 'Prepaid only: 16. Show them' })).toBeVisible();
  await axeClean(page);
  await def.getByRole('button', { name: 'Edit default' }).click();
  await page.getByRole('dialog', { name: 'Default delivery' }).getByLabel('Cash on delivery wherever we deliver').check();
  await page.getByRole('dialog', { name: 'Default delivery' }).getByRole('button', { name: 'Save' }).click();
  await expect(def).toContainText('Delivered, with cash on delivery');
});
