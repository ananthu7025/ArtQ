// Task 3.1: the storefront layout shell (product.md §4, design-system.md §5.8, §6.1).
import { DEFAULT_PUBLIC_SETTINGS, type Navigation, type PublicSettings } from '@artq/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { AnnouncementBar } from '../components/layout/AnnouncementBar';
import { Footer } from '../components/layout/Footer';
import { Header } from '../components/layout/Header';
import { NewsletterForm } from '../components/layout/NewsletterForm';
import { SiteToaster } from '../components/layout/SiteToaster';
import { WhatsAppButton } from '../components/layout/WhatsAppButton';
import { ApiError } from '../lib/api';
import { nav } from './setup';

const NAV: Navigation = { types: [
  { id: 1, name: 'Resins', slug: 'resins', href: '/type/resins', categories: [{ id: 11, name: 'Art Resin', slug: 'art-resin' }, { id: 12, name: 'Casting Resin', slug: 'casting-resin' }] },
  { id: 2, name: 'Pigments', slug: 'pigments', href: '/type/pigments', categories: [{ id: 21, name: 'Mica Powder', slug: 'mica-powder' }] },
  { id: 3, name: 'UV Resin', slug: 'uv-resin', href: '/category/uv-resin', categories: [] },
] };
const SETTINGS: PublicSettings = { ...DEFAULT_PUBLIC_SETTINGS, store: { ...DEFAULT_PUBLIC_SETTINGS.store, whatsapp: '+91 98470 12345' }, social: { ...DEFAULT_PUBLIC_SETTINGS.social, instagram: 'https://instagram.com/artq' } };

/** Validation rule: invalid field → aria-invalid, its message directly under it, linked by aria-describedby. */
function expectFieldError(label: string, message: string, cls = 'text-danger-700') {
  const field = screen.getByLabelText(label);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  const err = document.getElementById(`${field.id}-error`)!;
  expect(field.getAttribute('aria-describedby')).toContain(err.id);
  expect(err.textContent).toBe(message);
  expect(err.className).toContain(cls);
  expect(field.compareDocumentPosition(err) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}
const axeClean = async (el: Element) => expect((await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

describe('Header', () => {
  it('desktop: links in order with SHOP between Home and Shop all; current page marked; counts read out', async () => {
    nav.pathname = '/shop';
    const { container } = render(<Header navigation={NAV} cartCount={3} />);
    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(within(main).getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'Shop all', 'New arrivals', 'About us', 'Contact']);
    expect(within(main).getByRole('button', { name: 'Shop' }).getAttribute('aria-expanded')).toBe('false');
    expect(within(main).getByRole('link', { name: 'Shop all' }).getAttribute('aria-current')).toBe('page');
    expect(within(main).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Cart, 3 items' }).getAttribute('href')).toBe('/cart');
    expect(screen.getByRole('link', { name: 'Wishlist, 0 items' }).getAttribute('href')).toBe('/wishlist');   // 0 shows, like the reference
    expect(screen.getByRole('link', { name: 'Log in or sign up' }).getAttribute('href')).toBe('/login');
    expect(screen.getByRole('link', { name: /ARTQ.*home/ }).getAttribute('href')).toBe('/');
    await axeClean(container);
  });

  it('cart count: 1 item (singular) and more than 99 shown as 99+', () => {
    render(<Header navigation={NAV} cartCount={1} wishlistCount={250} />);
    expect(screen.getByRole('link', { name: 'Cart, 1 item' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Wishlist, 250 items' }).textContent).toContain('99+');
  });

  it('SHOP mega-menu: types → categories; a tile link override is used; Esc closes and returns focus; outside click closes', async () => {
    const u = userEvent.setup();
    render(<><Header navigation={NAV} /><p>Outside</p></>);
    const shop = screen.getByRole('button', { name: 'Shop' });
    await u.click(shop);
    expect(shop.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(shop.getAttribute('aria-controls')!)!;
    expect(panel.hidden).toBe(false);
    expect(within(panel).getByRole('link', { name: 'Resins' }).getAttribute('href')).toBe('/type/resins');
    expect(within(panel).getByRole('link', { name: 'Mica Powder' }).getAttribute('href')).toBe('/category/mica-powder');
    expect(within(panel).getByRole('link', { name: 'UV Resin' }).getAttribute('href')).toBe('/category/uv-resin');
    expect(within(panel).getByRole('link', { name: 'Shop all products' }).getAttribute('href')).toBe('/shop');
    await u.tab();
    expect(document.activeElement?.textContent).toBe('Resins');   // keyboard moves into the open panel
    await u.keyboard('{Escape}');
    expect(shop.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(shop);
    await u.click(shop);
    fireEvent.pointerDown(screen.getByText('Outside'));
    expect(shop.getAttribute('aria-expanded')).toBe('false');
  });

  it('keyboard: Enter on SHOP opens the panel, Enter again closes it (no hover involved)', async () => {
    const u = userEvent.setup();
    render(<Header navigation={NAV} />);
    const shop = screen.getByRole('button', { name: 'Shop' });
    act(() => { shop.focus(); });
    await u.keyboard('{Enter}');
    expect(shop.getAttribute('aria-expanded')).toBe('true');
    await u.keyboard('{Enter}');
    expect(shop.getAttribute('aria-expanded')).toBe('false');
  });

  it('mega-menu closes when the page changes and when focus leaves it', async () => {
    const u = userEvent.setup();
    const { rerender } = render(<Header navigation={NAV} />);
    const shop = screen.getByRole('button', { name: 'Shop' });
    await u.click(shop);
    nav.pathname = '/type/resins';
    rerender(<Header navigation={NAV} />);
    expect(shop.getAttribute('aria-expanded')).toBe('false');
    await u.click(shop);
    act(() => { screen.getByRole('link', { name: 'Shop all' }).focus(); });
    expect(shop.getAttribute('aria-expanded')).toBe('false');
  });

  it('no types yet: the mega-menu says so and still offers Shop all', async () => {
    const u = userEvent.setup();
    render(<Header navigation={{ types: [] }} />);
    await u.click(screen.getByRole('button', { name: 'Shop' }));
    expect(screen.getByText(/Our range is being updated/)).toBeTruthy();
  });

  it('mobile drawer: opens from ☰, lists types (expand to categories), traps focus, Esc closes and focus returns to ☰', async () => {
    const u = userEvent.setup();
    render(<Header navigation={NAV} />);
    const open = screen.getByRole('button', { name: 'Open menu' });
    await u.click(open);
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    const resins = within(drawer).getByRole('button', { name: 'Resins' });
    expect(resins.getAttribute('aria-expanded')).toBe('false');
    await u.click(resins);
    expect(resins.getAttribute('aria-expanded')).toBe('true');
    expect(within(drawer).getByRole('link', { name: 'Casting Resin' }).getAttribute('href')).toBe('/category/casting-resin');
    expect(within(drawer).getByRole('link', { name: 'All Resins' }).getAttribute('href')).toBe('/type/resins');
    expect(within(drawer).getByRole('link', { name: 'UV Resin' }).getAttribute('href')).toBe('/category/uv-resin');   // no categories → a plain link
    for (let i = 0; i < 25; i++) await u.tab();
    expect(drawer.contains(document.activeElement)).toBe(true);   // focus never leaves the drawer
    await axeClean(drawer);
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it('mobile drawer closes by itself after following a link (page change)', async () => {
    const u = userEvent.setup();
    const { rerender } = render(<Header navigation={NAV} />);
    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    await screen.findByRole('dialog', { name: 'Menu' });
    nav.pathname = '/about';
    rerender(<Header navigation={NAV} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('search: empty or too long → message on the field (shared rule); a query opens /search?q= and closes', async () => {
    const u = userEvent.setup();
    render(<Header navigation={NAV} />);
    await u.click(screen.getAllByRole('button', { name: 'Search' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Search the store' });
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Search products'));
    await u.click(within(dialog).getByRole('button', { name: 'Search' }));
    await waitFor(() => expectFieldError('Search products', 'Type what you are looking for'));
    await u.type(within(dialog).getByLabelText('Search products'), '   ');
    await u.click(within(dialog).getByRole('button', { name: 'Search' }));
    await waitFor(() => expectFieldError('Search products', 'Type what you are looking for'));
    const input = within(dialog).getByLabelText('Search products');
    await u.clear(input);
    await u.click(input);
    await u.paste('x'.repeat(101));
    await u.click(within(dialog).getByRole('button', { name: 'Search' }));
    await waitFor(() => expectFieldError('Search products', 'Use at most 100 characters'));
    expect(nav.push).not.toHaveBeenCalled();
    await u.clear(input);
    await u.type(input, '  mica & gold {Enter}');
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/search?q=mica%20%26%20gold'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('exactly 100 characters is a valid search', async () => {
    const u = userEvent.setup();
    render(<Header navigation={NAV} />);
    await u.click(screen.getAllByRole('button', { name: 'Search' })[0]!);
    const input = await screen.findByLabelText('Search products');
    await u.click(input);
    await u.paste('y'.repeat(100));
    await u.keyboard('{Enter}');
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/search?q=${'y'.repeat(100)}`));
  });

  it('phones: hides while scrolling down, returns when scrolling up; stays while the menu is open; never on desktop', async () => {
    const u = userEvent.setup();
    const header = () => document.querySelector('header')!;
    const scrollTo = (y: number) => act(() => { Object.defineProperty(window, 'scrollY', { value: y, configurable: true }); window.dispatchEvent(new Event('scroll')); });
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    render(<Header navigation={NAV} />);
    scrollTo(0); scrollTo(300);
    expect(header().hasAttribute('data-hidden')).toBe(true);
    scrollTo(250);
    expect(header().hasAttribute('data-hidden')).toBe(false);
    scrollTo(60);
    scrollTo(70);                                  // near the top: always shown
    expect(header().hasAttribute('data-hidden')).toBe(false);
    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    scrollTo(900);
    expect(header().hasAttribute('data-hidden')).toBe(false);
    await u.keyboard('{Escape}');
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    scrollTo(0); scrollTo(1500);
    expect(header().hasAttribute('data-hidden')).toBe(false);
  });
});

describe('AnnouncementBar', () => {
  it('messages separated by "•", read once (the moving copy is hidden); Pause stops it and says so', async () => {
    const u = userEvent.setup();
    const { container } = render(<AnnouncementBar enabled messages={['Shipping all over India', 'Free shipping on orders above ₹1000']} />);
    const region = screen.getByRole('region', { name: 'Announcements' });
    expect(region.className).toContain('bg-brand-800');
    expect(within(region).getAllByText('Shipping all over India')).toHaveLength(2);
    expect(within(region).getAllByText('Shipping all over India')[1]!.closest('[aria-hidden]')).toBeTruthy();
    expect(region.textContent).toContain('•');
    const pause = screen.getByRole('button', { name: 'Pause announcements' });
    await u.click(pause);
    expect(screen.getByRole('button', { name: 'Play announcements' }).getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.marquee')!.hasAttribute('data-paused')).toBe(true);
    await axeClean(container);
  });

  it('turned off, or no real messages → no bar at all', () => {
    expect(render(<AnnouncementBar enabled={false} messages={['x']} />).container.innerHTML).toBe('');
    expect(render(<AnnouncementBar enabled messages={[]} />).container.innerHTML).toBe('');
    expect(render(<AnnouncementBar enabled messages={['  ', '']} />).container.innerHTML).toBe('');
  });
});

describe('Footer', () => {
  it('TYPE lists active types (with link overrides); CONNECT, POLICIES, payment methods, copyright year, credit', async () => {
    const { container } = render(<Footer navigation={NAV} settings={SETTINGS} year={2026} />);
    const col = (t: string) => screen.getByRole('heading', { name: t }).parentElement!;
    expect(within(col('Type')).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Resins', '/type/resins'], ['Pigments', '/type/pigments'], ['UV Resin', '/category/uv-resin']]);
    expect(within(col('Connect')).getAllByRole('link').map((a) => a.textContent)).toEqual(['About Our Craft', 'Contact Us', 'FAQs', 'Instagram (opens in a new tab)', 'WhatsApp (opens in a new tab)']);
    expect(within(col('Connect')).getByRole('link', { name: /WhatsApp/ }).getAttribute('href')).toBe('https://wa.me/919847012345');
    expect(within(col('Policies')).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/terms', '/privacy-policy', '/shipping-policy', '/return-policy', '/cancellation-policy']);
    expect(screen.getByText('© 2026 ART Q. ALL RIGHTS RESERVED.')).toBeTruthy();
    expect(screen.getByText('powered by Eayila Consultancy')).toBeTruthy();
    expect(screen.getByText('Cash on delivery')).toBeTruthy();
    await axeClean(container);
  });

  it('no Instagram / WhatsApp set and no types yet: those links are left out, TYPE offers Shop all', () => {
    render(<Footer navigation={{ types: [] }} settings={DEFAULT_PUBLIC_SETTINGS} />);
    expect(screen.queryByRole('link', { name: /Instagram|WhatsApp/ })).toBeNull();
    expect(within(screen.getByRole('heading', { name: 'Type' }).parentElement!).getByRole('link').getAttribute('href')).toBe('/shop');
    expect(screen.getByText(`© ${new Date().getFullYear()} ART Q. ALL RIGHTS RESERVED.`)).toBeTruthy();
  });
});

describe('Newsletter form (shared rule with POST /v1/newsletter/subscribe)', () => {
  const setup = (post: (path: string, body: unknown) => Promise<unknown>) => {
    const fn = vi.fn(post);
    render(<><NewsletterForm post={fn as never} /><SiteToaster /></>);
    return fn;
  };
  const DARK = 'text-danger-300';

  it('empty → "Enter your email address"; bad → "Enter a valid email address"; 161 characters → limit; nothing sent', async () => {
    const u = userEvent.setup();
    const post = setup(async () => ({ status: 'SUBSCRIBED' }));
    await u.click(screen.getByRole('button', { name: 'Subscribe' }));
    await waitFor(() => expectFieldError('Email address', 'Enter your email address', DARK));
    await u.type(screen.getByLabelText('Email address'), 'not-an-email');
    await u.click(screen.getByRole('button', { name: 'Subscribe' }));
    await waitFor(() => expectFieldError('Email address', 'Enter a valid email address', DARK));
    await u.clear(screen.getByLabelText('Email address'));
    await u.click(screen.getByLabelText('Email address'));
    await u.paste(`${'a'.repeat(149)}@example.com`);
    await u.click(screen.getByRole('button', { name: 'Subscribe' }));
    await waitFor(() => expectFieldError('Email address', 'Use at most 160 characters', DARK));
    expect(post).not.toHaveBeenCalled();
  });

  it('valid (exactly 160 characters, spaces trimmed) → sends {email, source:"footer"}, thanks in a toast, clears the field', async () => {
    const u = userEvent.setup();
    const post = setup(async () => ({ status: 'SUBSCRIBED' }));
    const email = `${'a'.repeat(148)}@example.com`;
    await u.click(screen.getByLabelText('Email address'));
    await u.paste(`  ${email} `);
    await u.click(screen.getByRole('button', { name: 'Subscribe' }));
    expect(await screen.findByText('You’re subscribed. Thank you!')).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/newsletter/subscribe', { email, source: 'footer' });
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText('Email address').getAttribute('aria-invalid')).toBeNull();
  });

  it('already subscribed → a different, friendly toast', async () => {
    const u = userEvent.setup();
    setup(async () => ({ status: 'ALREADY_SUBSCRIBED' }));
    await u.type(screen.getByLabelText('Email address'), 'fan@example.com{Enter}');
    expect(await screen.findByText('You’re already on our list.')).toBeTruthy();
  });

  it('server VALIDATION_ERROR lands on the field; rate limit and network failure show a form message', async () => {
    const u = userEvent.setup();
    const replies: unknown[] = [
      new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'email', message: 'Enter a valid email address' }]),
      new ApiError(429, 'RATE_LIMITED', 'Too many requests'),
      new ApiError(0, 'NETWORK', 'We could not reach the store. Check your connection and try again.'),
    ];
    setup(async () => { throw replies.shift(); });
    const input = screen.getByLabelText('Email address');
    await u.type(input, 'fan@example.com{Enter}');
    await waitFor(() => expectFieldError('Email address', 'Enter a valid email address', DARK));
    await u.type(input, '{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('Too many tries. Please wait a minute and try again.');
    await u.type(input, '{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('We could not reach the store. Check your connection and try again.'));
    expect((input as HTMLInputElement).value).toBe('fan@example.com');   // kept so they can retry
  });

  it('while sending, the button says so and cannot be pressed twice', async () => {
    const u = userEvent.setup();
    let release!: () => void;
    const post = setup(() => new Promise((r) => { release = () => r({ status: 'SUBSCRIBED' }); }));
    await u.type(screen.getByLabelText('Email address'), 'fan@example.com{Enter}');
    const busy = await screen.findByRole('button', { name: 'Subscribing…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await u.click(busy);
    release();
    await screen.findByText('You’re subscribed. Thank you!');
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('WhatsApp button', () => {
  it('links to a chat with the store number (product name prefilled on a product page); opens WhatsApp', () => {
    render(<WhatsAppButton number="+91 98470 12345" productName="ArtQ 2:1 Epoxy Resin" />);
    const a = screen.getByRole('link', { name: 'Chat with us on WhatsApp (opens WhatsApp)' });
    expect(a.getAttribute('href')).toBe(`https://wa.me/919847012345?text=${encodeURIComponent('Hi ArtQ, I have a question about ArtQ 2:1 Epoxy Resin')}`);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('no number yet, or one that is not a phone number → no button', () => {
    expect(render(<WhatsAppButton number={null} />).container.innerHTML).toBe('');
    expect(render(<WhatsAppButton number="call us" />).container.innerHTML).toBe('');
  });
});
