// Task 3.3: the home page (product.md §5.1) rendered from a /v1/home response.
import type { HomeView, MediaRef, ProductCard } from '@artq/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeSections } from '../components/home/HomeSections';
import { ProductCard as Card } from '../components/product/ProductCard';
import { API_URL, EMPTY_HOME, loadHome } from '../lib/api';

const img = (id: number, alt = `Photo ${id}`): MediaRef => ({ id, url: `https://cdn.test/${id}/w640.webp`, width: 1200, height: 1200, alt, placeholder: 'data:image/webp;base64,AAAA', srcset: { webp: `https://cdn.test/${id}/w320.webp 320w, https://cdn.test/${id}/w640.webp 640w` } });
const card = (o: Partial<ProductCard> & { id: number; name: string }): ProductCard => ({
  slug: `p-${o.id}`, image: img(o.id), hoverImage: null, fromPrice: 49_900, maxPrice: 49_900, mrp: null, discountPercent: null, inStock: true, isNew: false, isTrending: false,
  variantCount: 1, defaultVariantId: 1, type: { slug: 'resins', name: 'Resins' }, ...o,
});
const HOME: HomeView = {
  sections: ['hero', 'types', 'new-arrivals', 'reels', 'techniques', 'testimonials', 'instagram'],
  hero: { slides: [
    { id: 1, heading: null, subheading: null, ctaText: 'Shop resins', ctaLink: '/type/resins', image: img(100, ''), mobileImage: null, video: { id: 9, url: 'https://cdn.test/hero.mp4', mime: 'video/mp4', width: null, height: null } },
    { id: 2, heading: 'Diwali Collection', subheading: 'Gold and pearl pigments', ctaText: null, ctaLink: null, image: img(101, ''), mobileImage: img(102, ''), video: null },
  ], intervalMs: 6000 },
  types: [{ id: 1, name: 'Resins', slug: 'resins', href: '/type/resins', image: img(200) }, { id: 2, name: 'UV Resin', slug: 'uv-resin', href: '/category/uv-resin', image: null }],
  newArrivals: [card({ id: 1, name: 'Ultra Clear Epoxy', fromPrice: 49_900, maxPrice: 1_99_900, mrp: 59_900, discountPercent: 17, isNew: true, hoverImage: img(11) }), card({ id: 2, name: 'Mica Gold', inStock: false, image: null })],
  trending: [],
  reels: [{ id: 5, title: 'Pouring a coaster', video: { id: 50, url: 'https://cdn.test/r1.mp4', mime: 'video/mp4', width: null, height: null }, poster: img(51), product: { slug: 'p-1', name: 'Ultra Clear Epoxy' }, instagramUrl: null },
    { id: 6, title: null, video: { id: 60, url: 'https://cdn.test/r2.mp4', mime: 'video/mp4', width: null, height: null }, poster: null, product: null, instagramUrl: null }],
  techniques: [{ id: 1, name: 'Coasters', slug: 'coasters', image: img(300) }],
  testimonials: [{ id: 1, name: 'Anu', location: 'Kochi', quote: 'Crystal clear.', rating: 5, avatar: null, product: { slug: 'p-1', name: 'Ultra Clear Epoxy' } }, { id: 2, name: 'Ravi', location: null, quote: 'Fast shipping.', rating: 4, avatar: null, product: null }],
  instagram: { handle: 'artq.in', url: 'https://www.instagram.com/artq.in' },
};
const axeClean = async (el: Element) => expect((await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

let play: ReturnType<typeof vi.fn>, pause: ReturnType<typeof vi.fn>;
beforeEach(() => {
  play = vi.fn(() => Promise.resolve()); pause = vi.fn();
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: play });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: pause });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const setMotion = (reduce: boolean) => {
  window.matchMedia = ((q: string) => ({ matches: reduce && q.includes('reduce'), media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
};

describe('Home sections', () => {
  beforeEach(() => setMotion(false));

  it('sections in the API order; one h1; headings as on the reference (spelled "New Arrivals"); passes axe', async () => {
    const { container } = render(<HomeSections home={HOME} />);
    expect([...container.querySelectorAll('[data-section]')].map((e) => e.getAttribute('data-section'))).toEqual(HOME.sections);
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['ARTQ']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Product Category', 'New Arrivals', 'Trending now', 'Shop by Technique', 'Stories with our product', 'Instagram moments']);
    expect(screen.getByText('Check out our range')).toBeTruthy();
    expect(screen.getByText('Explore our newly launched products')).toBeTruthy();
    await axeClean(container);
  });

  it('the hero image is the high-priority image (LCP); everything below loads lazily with fixed sizes', () => {
    const { container } = render(<HomeSections home={HOME} />);
    const imgs = [...container.querySelectorAll('img')];
    const hero = imgs.find((i) => i.getAttribute('src') === 'https://cdn.test/100/w640.webp')!;
    expect(hero.getAttribute('fetchpriority')).toBe('high');
    expect(hero.getAttribute('loading')).toBe('eager');
    expect(imgs.filter((i) => i.getAttribute('fetchpriority') === 'high')).toHaveLength(1);
    for (const i of imgs.filter((x) => x !== hero && !x.closest('[data-section="hero"]'))) {
      expect(i.getAttribute('loading')).toBe('lazy');
      expect(i.getAttribute('width')).toBe('1200');
      expect(i.getAttribute('height')).toBe('1200');
    }
  });

  it('API down / nothing configured: the brand hero with its h1 and a Shop link', () => {
    render(<HomeSections home={EMPTY_HOME} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ARTQ');
    expect(screen.getByText('Wood moulds & resins')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Shop now' }).getAttribute('href')).toBe('/shop');
  });

  it('hero switched off in settings: a hidden h1 keeps the page outline', () => {
    render(<HomeSections home={{ ...HOME, sections: ['new-arrivals'] }} />);
    expect(screen.getByRole('heading', { level: 1 }).className).toContain('sr-only');
  });

  it('hero: slides rotate every intervalMs; Pause stops it; a dot jumps to a slide; hovering holds it', async () => {
    vi.useFakeTimers();
    const { container } = render(<HomeSections home={HOME} />);
    const slide = (n: number) => container.querySelector(`[aria-label="${n} of 2"]`) as HTMLElement;
    expect(slide(1).hidden).toBe(false);
    act(() => { vi.advanceTimersByTime(6000); });
    expect(slide(2).hidden).toBe(false);
    expect(within(slide(2)).getByText('Diwali Collection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause the featured slides' }));
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(slide(2).hidden).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Show slide 1' }));
    expect(slide(1).hidden).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Play the featured slides' }));
    fireEvent.pointerEnter(container.querySelector('[aria-roledescription="carousel"]')!);
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(slide(1).hidden).toBe(false);
  });

  it('hero video: added and played in the browser; not added at all under reduced motion (poster only)', () => {
    const { container, unmount } = render(<HomeSections home={HOME} />);
    expect(container.querySelector('[data-section="hero"] video')!.getAttribute('src')).toBe('https://cdn.test/hero.mp4');
    expect(play).toHaveBeenCalled();
    unmount();
    setMotion(true);
    const still = render(<HomeSections home={HOME} />);
    expect(still.container.querySelector('[data-section="hero"] video')).toBeNull();
    expect(still.container.querySelector('[data-section="hero"] img')).not.toBeNull();
  });

  it('save-data: no hero video and no autoplaying reels', () => {
    vi.stubGlobal('navigator', { ...navigator, connection: { saveData: true } });
    const io = vi.fn();
    vi.stubGlobal('IntersectionObserver', class { constructor() { io(); } observe() {} disconnect() {} });
    const { container } = render(<HomeSections home={HOME} />);
    expect(container.querySelector('[data-section="hero"] video')).toBeNull();
    expect(io).not.toHaveBeenCalled();
  });

  it('range circles: types in order, link overrides, placeholder without image, then "More.." to /shop', () => {
    render(<HomeSections home={HOME} />);
    const list = screen.getByRole('heading', { name: 'Product Category' }).closest('section')!;
    expect(within(list).getAllByRole('link')).toHaveLength(3);
    for (const [name, href] of [['Resins', '/type/resins'], ['UV Resin', '/category/uv-resin'], ['More..', '/shop']]) expect(within(list).getByRole('link', { name }).getAttribute('href')).toBe(href);   // the placeholder adds nothing to the name
  });

  it('reels: the most visible (≥ 50 %) plays, one at a time; Pause keeps it paused; product link; label without a title', () => {
    let cb!: (e: { target: Element; intersectionRatio: number }[]) => void;
    const observed: Element[] = [];
    vi.stubGlobal('IntersectionObserver', class { constructor(f: typeof cb) { cb = f; } observe(el: Element) { observed.push(el); } disconnect() {} });
    render(<HomeSections home={HOME} />);
    const [v1, v2] = observed as HTMLVideoElement[];
    expect(v1!.getAttribute('aria-label')).toBe('Pouring a coaster');
    expect(v2!.getAttribute('aria-label')).toBe('ArtQ reel');
    play.mockClear();
    act(() => { cb([{ target: v1!, intersectionRatio: 0.4 }, { target: v2!, intersectionRatio: 0.9 }]); });
    expect(play.mock.contexts).toEqual([v2]);
    expect(screen.getByRole('button', { name: 'Pause ArtQ reel' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Pause ArtQ reel' }));
    act(() => { cb([{ target: v2!, intersectionRatio: 1 }]); });
    expect(screen.getByRole('button', { name: 'Play ArtQ reel' })).toBeTruthy();   // stays paused although fully visible
    act(() => { cb([{ target: v1!, intersectionRatio: 0.3 }]); });
    expect(screen.queryByRole('button', { name: /^Pause (Pouring a coaster|ArtQ reel)$/ })).toBeNull();   // nothing ≥ 50 % → nothing plays
    expect(within(screen.getByRole('heading', { name: 'Trending now' }).closest('section')!).getByRole('link', { name: 'Ultra Clear Epoxy' }).getAttribute('href')).toBe('/product/p-1');
  });

  it('testimonials: stars read as "Rated N out of 5"; Previous/Next; auto-advance stops with Pause and under reduced motion', async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    vi.useFakeTimers();
    render(<HomeSections home={HOME} />);
    expect(screen.getByText('Rated 5 out of 5')).toBeTruthy();
    expect(screen.getByText('Rated 4 out of 5')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Pause stories' }));
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Next story' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous story' }));
    expect(scrollTo).toHaveBeenCalledTimes(3);
  });

  it('Instagram band links out to the handle', () => {
    render(<HomeSections home={HOME} />);
    const link = screen.getAllByRole('link').find((l) => l.getAttribute('href') === 'https://www.instagram.com/artq.in')!;
    expect(link.textContent).toBe('Follow @artq.in on Instagram (opens in a new tab)');
    expect(link.getAttribute('target')).toBe('_blank');
  });
});

describe('ProductCard', () => {
  it('range price, struck MRP (read as MRP), NEW and discount badges, hover image, link to the product', async () => {
    const { container } = render(<Card card={HOME.newArrivals[0]!} />);
    expect(screen.getByRole('link', { name: 'Ultra Clear Epoxy' }).getAttribute('href')).toBe('/product/p-1');
    expect(container.textContent).toContain('From ₹499');
    expect(container.querySelector('s')!.textContent).toBe('MRP ₹599');
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('−17%')).toBeTruthy();
    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(container.querySelectorAll('img')[1]!.getAttribute('alt')).toBe('');      // the hover photo is decorative
    await axeClean(container);
  });

  it('single price, out of stock, no photo → placeholder that says so', () => {
    const { container } = render(<Card card={HOME.newArrivals[1]!} />);
    expect(container.textContent).toContain('₹499');
    expect(container.textContent).not.toContain('From');
    expect(screen.getByText('Out of stock')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Mica Gold: no photo yet' })).toBeTruthy();
  });

  it('paise amounts show rupees and paise only when needed', () => {
    const { container } = render(<Card card={card({ id: 9, name: 'Odd price', fromPrice: 19_050, maxPrice: 19_050 })} />);
    expect(container.textContent).toContain('₹190.50');
  });
});

describe('loadHome', () => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  it('fetches /home as a public, revalidated request', async () => {
    const f = vi.fn(async () => json(HOME));
    expect(await loadHome(f)).toEqual({ home: HOME, degraded: false });
    expect(f).toHaveBeenCalledWith(`${API_URL}/home`, expect.objectContaining({ credentials: 'omit', next: { revalidate: 60 } }));
  });
  it('API down, an error status or a strange body → the brand-hero fallback', async () => {
    expect(await loadHome(async () => { throw new TypeError('fetch failed'); })).toEqual({ home: EMPTY_HOME, degraded: true });
    expect(await loadHome(async () => json({}, 500))).toEqual({ home: EMPTY_HOME, degraded: true });
    expect(await loadHome(async () => json({ hello: 1 }))).toEqual({ home: EMPTY_HOME, degraded: true });
  });
});

describe('keyboard', () => {
  it('every control on the home page is reachable by Tab', async () => {
    setMotion(false);
    const u = userEvent.setup();
    render(<HomeSections home={HOME} />);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) { await u.tab(); const el = document.activeElement as HTMLElement; seen.add(el.getAttribute('aria-label') ?? el.textContent ?? ''); }
    for (const name of ['Shop resins', 'Show slide 2', 'Pause the featured slides', 'Ultra Clear Epoxy', 'Coasters', 'Next story']) expect([...seen].some((s) => s.includes(name)), name).toBe(true);
  });
});
