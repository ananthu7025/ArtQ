// ✅ Task 3.1 in a real browser: the storefront layout built from the real API (fixture: scripts/e2e-storefront-seed.ts).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const E2E_REDIS_URL = `redis://localhost:${process.env.ARTQ_REDIS_PORT ?? '56379'}/5`;
test.beforeAll(() => {
  // The newsletter limit (5/min per network) is real; every run starts with a fresh budget.
  execFileSync('pnpm', ['--dir', join(import.meta.dirname, '..', '..', 'api'), 'exec', 'tsx', 'scripts/e2e-reset-rate-limits.ts'], { env: { ...process.env, E2E_REDIS_URL }, stdio: 'pipe' });
});

async function axeClean(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

test.describe('desktop 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('announcement, header, mega-menu from the real menu, footer, WhatsApp; axe clean', async ({ page }) => {
    await page.goto('/');
    const bar = page.getByRole('region', { name: 'Announcements' });
    await expect(bar).toContainText('E2E festival offer');
    await expect(bar).toHaveCSS('background-color', 'rgb(0, 95, 90)');   // brand-800
    const main = page.getByRole('navigation', { name: 'Main' });
    await expect(main.getByRole('link')).toHaveText(['Home', 'Shop all', 'New arrivals', 'About us', 'Contact']);
    await expect(page.getByRole('link', { name: 'Cart, 0 items' })).toBeVisible();
    await axeClean(page);

    // Hover opens SHOP; the click that follows keeps it open; the panel lists the seeded types → categories.
    const shop = main.getByRole('button', { name: 'Shop' });
    await shop.hover();
    await expect(shop).toHaveAttribute('aria-expanded', 'true');
    await shop.click();
    await expect(shop).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator(`#${await shop.getAttribute('aria-controls')}`.replace(/:/g, '\\:'));
    await expect(panel.getByRole('link', { name: 'Pigments', exact: true })).toHaveAttribute('href', '/type/pigments');
    await expect(panel.getByRole('link', { name: 'Mica Powder Pigments' })).toBeVisible();
    await expect(panel).not.toContainText('Retired Range');               // inactive type left out
    await axeClean(page);
    await page.keyboard.press('Escape');
    await expect(shop).toHaveAttribute('aria-expanded', 'false');
    await expect(shop).toBeFocused();

    const footer = page.locator('footer');
    await expect(footer.getByRole('heading', { name: 'Type' }).locator('..').getByRole('link')).toHaveText(['Resins', 'Wooden Frames', 'Multiwood Frames', 'Hoops', 'Silica Gel', 'Pigments', 'Glitters', 'Resin Art Essentials']);
    await expect(footer).toContainText(`© ${new Date().getFullYear()} ART Q. ALL RIGHTS RESERVED.`);
    await expect(page.getByRole('link', { name: 'Chat with us on WhatsApp (opens WhatsApp)' })).toHaveAttribute('href', 'https://wa.me/919847012345');
  });

  test('following a menu link: the mega-menu closes and the next page keeps the layout (404 until listings exist)', async ({ page }) => {
    await page.goto('/');
    const shop = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Shop' });
    await shop.click();
    await page.getByRole('link', { name: 'Mica Powder Pigments' }).click();
    await expect(page).toHaveURL(/\/category\/mica-powder-pigments$/);
    await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
    await expect(shop).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('footer')).toBeVisible();
    await axeClean(page);
  });

  test('newsletter: invalid → red border + message under the field; valid → subscribed; again → already on the list', async ({ page }) => {
    await page.goto('/');
    const email = page.getByLabel('Email address');
    await email.fill('not-an-email');
    await page.getByRole('button', { name: 'Subscribe' }).click();
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#newsletter-email-error')).toHaveText('Enter a valid email address');
    await expect(email).toHaveCSS('border-bottom-color', 'rgb(252, 165, 165)');   // danger-300 on the dark footer
    await expect(page.locator('#newsletter-email-error')).toHaveCSS('color', 'rgb(252, 165, 165)');
    await axeClean(page);
    const address = `fan-${Date.now()}@example.com`;
    await email.fill(address);
    await page.getByRole('button', { name: 'Subscribe' }).click();
    await expect(page.getByText('You’re subscribed. Thank you!')).toBeVisible();
    await expect(email).toHaveValue('');
    await email.fill(address.toUpperCase());
    await page.getByRole('button', { name: 'Subscribe' }).click();
    await expect(page.getByText('You’re already on our list.')).toBeVisible();
  });

  test('the announcement pauses on request; with reduced motion it does not move at all', async ({ page }) => {
    await page.goto('/');
    const track = page.locator('.marquee-track');
    await expect(track).toHaveCSS('animation-play-state', 'running');
    await page.getByRole('button', { name: 'Pause announcements' }).click();
    await expect(track).toHaveCSS('animation-play-state', 'paused');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await expect(page.locator('.marquee-track')).toHaveCSS('animation-name', 'none');
  });
});

test('caching (task 3.2): pages are regenerated every 60 s; the API marks public data shareable and personal data private', async ({ request }) => {
  const home = await request.get('/');
  expect(home.headers()['cache-control']).toContain('s-maxage=60');
  const nav = await request.get('http://localhost:4001/v1/navigation', { headers: { Cookie: 'aq_cart=abc' } });
  expect(nav.headers()['cache-control']).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=60');
  expect(nav.headers()['set-cookie']).toBeUndefined();
  const me = await request.get('http://localhost:4001/v1/me');
  expect(me.status()).toBe(401);
  expect(me.headers()['cache-control']).toBe('private, no-store');
});

test.describe('phone 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('drawer: types expand to categories, focus stays inside, Esc closes and returns focus to ☰; axe clean', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
    const open = page.getByRole('button', { name: 'Open menu' });
    await open.click();
    const drawer = page.getByRole('dialog', { name: 'Menu' });
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390 * 0.85 + 1);
    await drawer.getByRole('button', { name: 'Pigments' }).click();
    await expect(drawer.getByRole('link', { name: 'Gel Pigments' })).toBeVisible();
    await axeClean(page);
    for (let i = 0; i < 30; i++) await page.keyboard.press('Tab');
    expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(open).toBeFocused();
  });

  test('the phone header shows exactly ☰ 🔍 · logo · account ♡ 🛒 (no desktop-only controls)', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('header');
    await expect(header.getByRole('button', { name: 'Search' })).toHaveCount(1);
    await expect(header.getByRole('link', { name: 'Log in or sign up' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Login / Sign up' })).toBeHidden();
    await expect(header.locator('button:visible, a:visible')).toHaveCount(6);   // ☰ 🔍 logo 👤 ♡ 🛒
    for (const [role, name] of [['button', 'Open menu'], ['link', /ARTQ.*home/], ['link', 'Wishlist, 0 items'], ['link', 'Cart, 0 items']] as const) {
      await expect(header.getByRole(role, { name })).toBeVisible();
    }
  });

  test('header slides away while scrolling down and returns when scrolling up', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('header');
    await page.mouse.wheel(0, 600);
    await expect(header).toHaveAttribute('data-hidden', 'true');
    await page.mouse.wheel(0, -200);
    await expect(header).not.toHaveAttribute('data-hidden', /.*/);
    await expect(header).toBeInViewport();
  });

  test('search: empty shows the message on the field; a query opens the results URL', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Search' }).click();
    const input = page.getByLabel('Search products');
    await expect(input).toBeFocused();
    await page.getByRole('dialog').getByRole('button', { name: 'Search', exact: true }).click();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#site-search-error')).toHaveText('Type what you are looking for');
    await expect(input).toHaveCSS('border-top-color', 'rgb(185, 28, 28)');
    await input.fill('mica powder');
    await input.press('Enter');
    await expect(page).toHaveURL((u) => u.pathname === '/search' && u.searchParams.get('q') === 'mica powder');
  });
});
