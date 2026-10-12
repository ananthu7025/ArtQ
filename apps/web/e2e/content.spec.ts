// ✅ Task 6.2 in a real browser against the real API and worker: the footer's pages exist (About, a policy page), the
// FAQ page opens an answer in place, an unknown address shows the 404 page, and the contact form checks its fields,
// sends, thanks the visitor, and the acknowledgement arrives (Mailpit).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const MAILPIT = `http://localhost:${process.env.ARTQ_MAIL_UI_PORT ?? '8025'}/api/v1`;
test.use({ viewport: { width: 1280, height: 900 } });
async function axeClean(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

test('content pages, FAQs and 404', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('contentinfo').getByRole('link', { name: 'Return & Refund Policy' }).click();
  await expect(page).toHaveURL(/\/return-policy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Return & Refund Policy' })).toBeVisible();
  await axeClean(page);
  await page.goto('/about');
  await expect(page.getByRole('heading', { level: 1, name: 'About Our Craft' })).toBeVisible();
  await page.goto('/faqs');
  await page.getByText('Can I pay cash on delivery?').click();
  await expect(page.getByText(/for orders between ₹200 and ₹5,000/)).toBeVisible();
  await axeClean(page);
  const missing = await page.goto('/this-page-does-not-exist');
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
});

test('contact form: errors under the fields, sent, thanked, acknowledged by email', async ({ page }) => {
  const email = `e2e-contact-${Date.now().toString(36)}@example.com`;
  await page.goto('/contact');
  const form = page.getByRole('form', { name: 'Contact us' });
  await form.getByRole('button', { name: 'Send message' }).click();
  await expect(form.getByLabel('Your name')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByText('Write your message (at least 10 characters)')).toBeVisible();
  await form.getByLabel('Your name').fill('Asha Menon');
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Subject').fill('Bulk order for a workshop');
  await form.getByLabel('Message').fill('We need 20 resin kits for a workshop next month. Can you quote?');
  await axeClean(page);
  await form.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('heading', { name: 'Thank you, we’ve got your message' })).toBeVisible();
  await expect.poll(async () => ((await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages: { Subject: string }[] }).messages[0]?.Subject, { timeout: 20_000 }).toBe('We’ve received your message');
});
