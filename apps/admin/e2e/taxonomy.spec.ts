// ✅ Task 2.6 against the real API: a type in use cannot be deleted (409 with guidance); once unused it can.
import { expect, test } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1280, height: 800 } });

test('types and categories: add, refuse deleting a type in use, delete in the right order', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('owner@e2e.artq.in');
  await page.getByLabel('Password').fill('e2e-owner-passphrase');
  await page.getByRole('button', { name: 'Log in' }).click();

  await page.getByRole('link', { name: 'Product Types', exact: true }).click();
  await page.getByRole('button', { name: 'Add product type' }).click();
  await page.getByRole('dialog', { name: 'Add product type' }).getByLabel('Name').fill('E2E Wooden Frames');
  await page.getByRole('dialog', { name: 'Add product type' }).getByRole('button', { name: 'Add product type' }).click();
  const typeRow = page.getByRole('row').filter({ hasText: 'E2E Wooden Frames' });
  await expect(typeRow).toContainText('/e2e-wooden-frames');
  await axeClean(page);

  await page.getByRole('link', { name: 'Categories', exact: true }).click();
  await page.getByRole('button', { name: 'Add category' }).click();
  const add = page.getByRole('dialog', { name: 'Add category' });
  await add.getByLabel('Name').fill('E2E Teak');
  await add.getByLabel('Product type').selectOption({ label: 'E2E Wooden Frames' });
  await add.getByRole('button', { name: 'Add category' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'E2E Teak' })).toContainText('E2E Wooden Frames');

  // The type is used by a category: the API refuses and the page says why.
  await page.getByRole('link', { name: 'Product Types', exact: true }).click();
  await typeRow.getByRole('button', { name: 'Delete E2E Wooden Frames' }).click();
  await page.getByRole('dialog', { name: 'Delete “E2E Wooden Frames”?' }).getByRole('button', { name: 'Delete' }).click();
  const refused = page.getByRole('dialog', { name: '“E2E Wooden Frames” is still in use' });
  await expect(refused).toContainText('is used by 1 category');
  await refused.getByRole('button', { name: 'OK' }).click();
  await expect(typeRow).toBeVisible();

  // Delete the category first, then the type.
  await page.getByRole('link', { name: 'Categories', exact: true }).click();
  await page.getByRole('row').filter({ hasText: 'E2E Teak' }).getByRole('button', { name: 'Delete E2E Teak' }).click();
  await page.getByRole('dialog', { name: 'Delete “E2E Teak”?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('“E2E Teak” deleted').first()).toBeVisible();
  await page.getByRole('link', { name: 'Product Types', exact: true }).click();
  await typeRow.getByRole('button', { name: 'Delete E2E Wooden Frames' }).click();
  await page.getByRole('dialog', { name: 'Delete “E2E Wooden Frames”?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('“E2E Wooden Frames” deleted').first()).toBeVisible();
  await expect(typeRow).toHaveCount(0);
});
