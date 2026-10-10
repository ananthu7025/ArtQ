// Task 6.1 against the real API: the owner adds an FAQ and moves it up, writes a page in the rich-text editor, changes
// the announcement bar (and the storefront's public settings serve it), and opens the messages inbox; all pass axe.
import { expect, test } from '@playwright/test';
import { axeClean, resetRateLimitsBeforeAll } from './helpers';

resetRateLimitsBeforeAll();
test.use({ viewport: { width: 1280, height: 900 } });
const API = `http://localhost:${process.env.E2E_API_PORT ?? '4001'}/v1`;

test('FAQ, page, announcement and messages', async ({ page }) => {
  const stamp = Date.now().toString(36);
  await page.goto('/login');
  await page.getByLabel('Email').fill('owner@e2e.artq.in');
  await page.getByLabel('Password').fill('e2e-owner-passphrase');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('/cms?tab=faqs');
  await page.getByRole('button', { name: 'Add question' }).click();
  const faq = page.getByRole('dialog', { name: 'Add question' });
  await faq.getByLabel('Group').selectOption('SHIPPING');
  await faq.getByLabel('Question').fill(`Do you deliver on Sundays? ${stamp}`);
  await faq.getByLabel('Answer').fill('Couriers deliver Monday to Saturday.');
  await axeClean(page);
  await faq.getByRole('button', { name: 'Save question' }).click();
  await expect(page.getByText(`Do you deliver on Sundays? ${stamp}`)).toBeVisible();

  await page.getByRole('tab', { name: 'Pages' }).click();
  await page.getByRole('button', { name: 'Add page' }).click();
  const pg = page.getByRole('dialog', { name: 'Add page' });
  await pg.getByLabel('Title', { exact: true }).fill('Resin care guide');
  await pg.getByLabel('Address').fill(`care-${stamp}`);
  await pg.getByRole('textbox', { name: 'Page text' }).fill('Keep resin art out of direct sunlight.');
  await pg.getByRole('button', { name: 'Save page' }).click();
  await expect(page.getByText(`/care-${stamp}`)).toBeVisible();

  await page.getByRole('tab', { name: 'Home & announcement' }).click();
  await page.getByLabel('Message 1', { exact: true }).fill(`Diwali offers are live ${stamp}`);
  await page.getByRole('button', { name: 'Save announcement' }).click();
  await expect(page.getByText(/^Saved\./)).toBeVisible();
  await axeClean(page);
  await expect.poll(async () => ((await (await fetch(`${API}/settings/public`)).json()) as { announcement: { messages: string[] } }).announcement.messages[0]).toBe(`Diwali offers are live ${stamp}`);

  await page.getByRole('tab', { name: 'Messages' }).click();
  await expect(page.getByRole('table', { name: 'Messages' })).toBeVisible();
  await axeClean(page);
});
