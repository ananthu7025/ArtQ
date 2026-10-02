// Staff & Permissions end to end: the owner invites a person (password re-check), the person follows the emailed link,
// chooses a password and logs in with the role they were given; the owner blocks them and they are refused.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const OWNER = { email: 'owner@e2e.artq.in', password: 'e2e-owner-passphrase' };
const STAFF = { email: 'staff@e2e.artq.in' };
const E2E_DATABASE_URL = `postgresql://artq:artq@localhost:${process.env.ARTQ_PG_PORT ?? '55432'}/artq_e2e`;

async function login(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/** The link in the latest email of `template` to `email`, read from the e2e database outbox. */
function lastLink(email: string, template = 'staff_invite'): string {
  const api = join(import.meta.dirname, '..', '..', 'api');
  return execFileSync('pnpm', ['--dir', api, 'exec', 'tsx', 'scripts/e2e-last-link.ts', email, template], { env: { ...process.env, E2E_DATABASE_URL }, encoding: 'utf8' }).trim();
}

async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

test('invite → choose password → log in as STAFF → blocked by the owner', async ({ page, browser }) => {
  const email = `devika.${Date.now()}@e2e.artq.in`;
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
  const link = new URL(lastLink(email));
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
  await page.getByLabel('Email').fill(STAFF.email);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  expect(new URL(lastLink(STAFF.email, 'password_reset')).pathname).toBe('/reset-password');
  await axeClean(page);
});
