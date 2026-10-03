// ✅ Task 3.3 in a real browser: the home page built from the real API (demo-loaded database), and
// ✅ LCP < 2.5 s on throttled 4G (Lighthouse's "slow 4G": 1.6 Mbps down, 150 ms RTT, 4× CPU slowdown; phone viewport).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function axeClean(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

test.describe('desktop 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('sections in order, from the real catalogue: hero, range circles, New Arrivals, Trending, techniques, stories; axe clean', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ARTQ');
    expect(await page.locator('[data-section]').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')))).toEqual(['hero', 'types', 'new-arrivals', 'trending', 'techniques', 'testimonials']);
    const range = page.locator('[data-section="types"]');
    const names = ['Resins', 'Wooden Frames', 'Multiwood Frames', 'Hoops', 'Silica Gel', 'Pigments', 'Glitters', 'Resin Art Essentials', 'More..'];
    await expect(range.getByRole('link')).toHaveCount(names.length);
    for (const [i, name] of names.entries()) await expect(range.getByRole('link').nth(i)).toHaveAccessibleName(name);
    const arrivals = page.locator('[data-section="new-arrivals"]');
    await expect(arrivals.getByRole('heading', { level: 2 })).toHaveText('New Arrivals');
    await expect(arrivals.locator('article')).toHaveCount(8);
    await expect(arrivals.getByRole('link', { name: 'ArtQ Ultra Clear 2:1 Epoxy Resin' })).toHaveAttribute('href', /^\/product\/.+/);
    await expect(arrivals.getByText('New').first()).toBeVisible();
    await expect(page.locator('[data-section="trending"]').locator('article')).toHaveCount(4);
    await expect(page.locator('[data-section="techniques"]').getByRole('link').first()).toHaveAttribute('href', /^\/technique\//);
    await expect(page.locator('[data-section="testimonials"]')).toContainText('Rated 5 out of 5');
    // Every product photo really loads from storage (not just an <img> tag).
    await arrivals.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-section="new-arrivals"] article img')].every((i) => (i as HTMLImageElement).complete));
    const broken = await arrivals.locator('article img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth === 0).length);
    expect(broken).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await axeClean(page);
  });

  test('a sold-out size shows on its card; a card opens its product page URL', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Out of stock').first()).toBeVisible();
    const card = page.locator('[data-section="new-arrivals"] article').first();
    const href = await card.getByRole('link').getAttribute('href');
    await card.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });

  test('stories carousel: Next moves to the next story; Pause is announced as pressed', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });   // two stories per view, so there is somewhere to move
    await page.goto('/');
    const stories = page.locator('[data-section="testimonials"]');
    await stories.getByRole('button', { name: 'Pause stories' }).click();
    await expect(stories.getByRole('button', { name: 'Play stories' })).toHaveAttribute('aria-pressed', 'true');
    const track = stories.locator('[aria-roledescription="slide"]').first().locator('..');
    const before = await track.evaluate((t) => t.scrollLeft);
    await stories.getByRole('button', { name: 'Next story' }).click();
    await expect.poll(() => track.evaluate((t) => t.scrollLeft)).toBeGreaterThan(before);
  });
});

test.describe('phone 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('✅ LCP < 2.5 s on throttled 4G (slow 4G + 4× CPU); the hero image is the largest element; no layout shift from images', async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.addInitScript(() => {
      const w = window as unknown as { __lcp: { t: number; tag: string; src: string }; __cls: number };
      w.__lcp = { t: 0, tag: '', src: '' }; w.__cls = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries() as (PerformanceEntry & { element?: Element; url?: string })[]) w.__lcp = { t: e.startTime, tag: e.element?.tagName ?? '', src: e.url ?? '' }; }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) w.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto('/', { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(1500);   // let LCP settle
    const { lcp, cls } = await page.evaluate(() => { const w = window as unknown as { __lcp: { t: number; tag: string; src: string }; __cls: number }; return { lcp: w.__lcp, cls: w.__cls }; });
    test.info().annotations.push({ type: 'LCP', description: `${Math.round(lcp.t)} ms (${lcp.tag} ${lcp.src.split('/').slice(-3).join('/')}), CLS ${cls.toFixed(3)}` });
    expect(lcp.t).toBeGreaterThan(0);
    expect(lcp.t).toBeLessThan(2500);
    expect(lcp.tag).toBe('IMG');
    expect(lcp.src).toContain('/demo/hero/');
    expect(cls).toBeLessThan(0.1);
  });

  test('phone layout: 3-column range circles, 2-column cards; axe clean', async ({ page }) => {
    await page.goto('/');
    // Nothing may widen the page sideways (a stray absolutely-positioned element once made it 690 px wide).
    expect(await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])).toEqual([390, 390]);
    const circles = page.locator('[data-section="types"] li');
    const boxes = await circles.evaluateAll((els) => els.slice(0, 4).map((e) => e.getBoundingClientRect().top));
    expect(boxes[0]).toBe(boxes[2]);
    expect(boxes[3]).toBeGreaterThan(boxes[0]!);
    const cards = await page.locator('[data-section="new-arrivals"] li').evaluateAll((els) => els.slice(0, 3).map((e) => e.getBoundingClientRect().top));
    expect(cards[0]).toBe(cards[1]);
    expect(cards[2]).toBeGreaterThan(cards[0]!);
    await axeClean(page);
  });
});

test.describe('reduced motion', () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  test('nothing moves by itself: the stories carousel does not advance', async ({ page }) => {
    await page.goto('/');
    const track = page.locator('[data-section="testimonials"] [aria-roledescription="slide"]').first().locator('..');
    await page.waitForTimeout(7000);
    expect(await track.evaluate((t) => t.scrollLeft)).toBe(0);
  });
});
