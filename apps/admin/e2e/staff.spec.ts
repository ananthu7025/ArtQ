// Staff & Permissions end to end: the owner invites a person (password re-check), the person follows the emailed link,
// chooses a password and logs in with the role they were given; the owner blocks them and they are refused.
import { expect, test, type Page } from '@playwright/test';
import { axeClean, emailLink, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();

const OWNER = { email: 'owner@e2e.artq.in', password: 'e2e-owner-passphrase' };
const STAFF = { email: 'staff@e2e.artq.in' };

async function login(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Log in' }).click();
}


test('invite → choose password → log in as STAFF → blocked by the owner', async ({ page, browser }) => {
  const email = `devika.${Date.now()}@e2e.artq.in`;
  const started = new Date(Date.now() - 1000);
  await login(page, OWNER);
  await page.getByRole('link', { name: 'Staff & Permissions' }).click();
  await expect(page.getByRole('table', { name: 'Staff members' })).toContainText('owner@e2e.artq.in');
  await axeClean(page);

  await page.getByRole('button', { name: 'Add staff' }).click();
  const add = page.getByRole('dialog', { name: 'Add staff' });
  await add.getByLabel('Name').fill('Devika');
  await add.getByLabel('Email').fill(email);
  await add.getByLabel('Role').selectOption('STAFF');
  await add.getByRole('button', { name: 'Send invite' }).click();
  // the change needs the password again
  await page.getByRole('dialog', { name: 'Confirm it’s you' }).or(page.getByRole('dialog', { name: "Confirm it's you" })).getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText(`Invite sent to ${email}`)).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row).toContainText('Invite pending');

  // the invited person, in a separate browser context
  const theirs = await browser.newContext();
  const them = await theirs.newPage();
  const link = await emailLink(email, started, '/reset-password');   // the invite, as delivered
  expect(link.pathname).toBe('/reset-password');
  await them.goto(link.pathname + link.search);
  await them.getByLabel('New password').fill('devika-chooses-this');
  await them.getByLabel('Repeat the password').fill('devika-chooses-this');
  await them.getByRole('button', { name: 'Set password' }).click();
  await expect(them.getByRole('heading', { name: 'Password set' })).toBeVisible();
  await them.getByRole('link', { name: 'Log in' }).click();
  await login(them, { email, password: 'devika-chooses-this' });
  await expect(them.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(them.getByRole('link', { name: 'Staff & Permissions' })).toHaveCount(0);   // STAFF role

  // the owner blocks them (still within the step-up window)
  await page.reload();
  await expect(row).toContainText('Active');
  await row.getByRole('button', { name: /^Manage / }).click();
  await page.getByRole('button', { name: 'Block' }).click();
  await page.getByRole('dialog', { name: 'Block Devika?' }).getByRole('button', { name: 'Block' }).click();
  await expect(row).toContainText('Blocked');

  await login(them, { email, password: 'devika-chooses-this' });
  await expect(them.getByRole('alert')).toHaveText('This account is disabled. Contact the store owner.');
  await theirs.close();
});

// (STAFF being refused the Staff page is covered by the UI and API tests; logging in again here would trip the real
// 10/min login limit shared by the whole e2e run.)
test('"Forgot password" from the login page emails a link to the admin reset page', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();   // client-side navigation done
  // Validation rule: an invalid field renders a red border and its message directly under it.
  await page.getByRole('button', { name: 'Send link' }).click();
  const email = page.getByLabel('Email');
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toHaveCSS('border-top-color', 'rgb(185, 28, 28)');   // --color-danger-700
  await expect(page.locator('#email-error')).toHaveText('Enter your email address');
  await expect(page.locator('#email-error')).toHaveCSS('color', 'rgb(185, 28, 28)');
  await page.getByLabel('Email').fill(STAFF.email);
  const sent = new Date(Date.now() - 1000);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  expect((await emailLink(STAFF.email, sent, '/reset-password')).pathname).toBe('/reset-password');
  await axeClean(page);
});
