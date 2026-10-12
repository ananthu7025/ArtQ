// Task 6.2: content pages and forms. The loaders (published page, 404, API down; FAQs), the FAQ page and a content page
// rendered from them, and the two forms against a fake API: the shared rules under each field, a server refusal on its
// field (also inside custom-work details), the rate-limit message, the thank-you state, and custom-work photos uploaded
// and processed before Send.
import type { FaqView, PublicPage } from '@artq/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ContentPage from '../app/[slug]/page';
import FaqsPage from '../app/faqs/page';
import { AuthProvider } from '../components/account/AuthProvider';
import { ContactForm, CustomWorkForm } from '../components/content/forms';
import { ShopProvider } from '../components/shop/ShopProvider';
import { API_URL, loadFaqs, loadPage } from '../lib/api';
import { StoreSession } from '../lib/session';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (status: number, code: string, message: string, details?: unknown) => json({ error: { code, message, details } }, status);
const page: PublicPage = { slug: 'shipping-policy', title: 'Shipping Policy', content: '<p>We ship across India in <strong>4–7 days</strong>.</p>', metaTitle: null, metaDescription: 'How we ship', updatedAt: '2026-10-09T06:00:00Z' };
const faqs: FaqView = { groups: [{ group: 'SHIPPING', label: 'Shipping', items: [{ question: 'How long does delivery take?', answer: '4 to 7 days.' }] }] };

type Route = (body: unknown) => Response | Promise<Response>;
let routes: Record<string, Route>;
let calls: { method: string; path: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  routes = { 'GET /cart': () => json({ items: [], coupon: null, warnings: [], totals: { itemCount: 0 } }) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.startsWith(API_URL) ? url.slice(API_URL.length) : url;
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body ? '[file]' : undefined;
    calls.push({ method, path, body });
    const r = routes[`${method} ${path}`];
    if (!r) throw new TypeError('Failed to fetch');
    return r(body);
  }));
});
afterEach(() => vi.unstubAllGlobals());
const app = (children: ReactNode) => render(<AuthProvider session={new StoreSession({ channel: null, locks: null })}><ShopProvider>{children}</ShopProvider></AuthProvider>);
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const expectFieldError = (label: string | RegExp, msg: string) => {
  const el = screen.getByLabelText(label);
  expect(el.getAttribute('aria-invalid')).toBe('true');
  expect((el.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent)).toContain(msg);
};

describe('loaders and pages', () => {
  it('a page: published → shown; 404 → missing; unreachable → unavailable; bad slugs never fetched', async () => {
    routes['GET /pages/shipping-policy'] = () => json(page);
    routes['GET /pages/nope'] = () => apiError(404, 'NOT_FOUND', 'Page not found');
    expect(await loadPage('shipping-policy')).toEqual(page);
    expect(await loadPage('nope')).toBe('missing');
    expect(await loadPage('offline')).toBe('unavailable');
    expect(await loadPage('Bad_Slug')).toBe('missing');
    expect(sent('GET', '/pages/Bad_Slug')).toEqual([]);
    const { container } = render(await ContentPage({ params: Promise.resolve({ slug: 'shipping-policy' }) }));
    expect(screen.getByRole('heading', { level: 1, name: 'Shipping Policy' })).toBeTruthy();
    expect(container.querySelector('.prose-artq strong')?.textContent).toBe('4–7 days');
    expect(screen.getByText(/^Last updated 9 October 2026$/)).toBeTruthy();
  });

  it('FAQs: grouped questions that open in place, with FAQPage data; the API down is said plainly', async () => {
    routes['GET /faqs'] = () => json(faqs);
    expect(await loadFaqs()).toEqual(faqs);
    const { container, unmount } = render(await FaqsPage());
    expect(screen.getByRole('heading', { level: 2, name: 'Shipping' })).toBeTruthy();
    expect(screen.getByText('How long does delivery take?').closest('details')).toBeTruthy();
    expect(JSON.parse(container.querySelector('script[type="application/ld+json"]')!.textContent!)).toMatchObject({ '@type': 'FAQPage', mainEntity: [{ name: 'How long does delivery take?', acceptedAnswer: { text: '4 to 7 days.' } }] });
    await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } }).then((r) => expect(r.violations.map((v) => v.id)).toEqual([]));
    unmount();
    delete routes['GET /faqs'];
    render(await FaqsPage());
    expect(screen.getByText('We couldn’t load the questions just now. Please try again in a minute.')).toBeTruthy();
  });
});

describe('contact form', () => {
  it('rules under each field; a server refusal on its field; rate limit explained; thanks', async () => {
    const u = userEvent.setup();
    let reply: Route = () => apiError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'email', message: 'Enter a valid email address' }]);
    routes['POST /contact'] = (b) => reply(b);
    const { container } = app(<ContactForm />);
    await u.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expectFieldError('Your name', 'Enter your name'));
    expectFieldError('Subject', 'Enter a subject');
    expectFieldError('Message', 'Write your message (at least 10 characters)');
    await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } }).then((r) => expect(r.violations.map((v) => v.id)).toEqual([]));
    await u.type(screen.getByLabelText('Your name'), 'Asha Menon');
    await u.type(screen.getByLabelText('Email'), 'asha@example.com');
    await u.type(screen.getByLabelText('Subject'), 'Order question');
    await u.type(screen.getByLabelText('Order number (optional)'), 'x1');
    await u.type(screen.getByLabelText('Message'), 'Where is my parcel, please?');
    await u.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expectFieldError('Order number (optional)', 'Enter an order number like AQ10234'));
    await u.clear(screen.getByLabelText('Order number (optional)'));
    await u.type(screen.getByLabelText('Order number (optional)'), 'aq10234');
    await u.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expectFieldError('Email', 'Enter a valid email address'));
    reply = () => apiError(429, 'RATE_LIMITED', 'Too many requests');
    await u.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('You’ve sent a few messages just now. Please wait a minute and try again.')).toBeTruthy();
    reply = () => json({ id: 1, received: true }, 201);
    await u.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByRole('heading', { name: 'Thank you, we’ve got your message' })).toBeTruthy();
    expect(sent('POST', '/contact').at(-1)!.body).toEqual({ name: 'Asha Menon', email: 'asha@example.com', phone: null, subject: 'Order question', message: 'Where is my parcel, please?', orderNumber: 'AQ10234' });
  });
});

describe('custom work form', () => {
  it('numbers checked by the shared rules; a photo uploaded and processed first; a server refusal inside details lands on its field', async () => {
    const u = userEvent.setup();
    routes['POST /uploads/presign'] = () => json({ media: { id: 81 }, upload: { url: 'https://storage.test/priv/x.jpg', headers: { 'Content-Type': 'image/jpeg' } } }, 201);
    routes['PUT https://storage.test/priv/x.jpg'] = () => new Response(null, { status: 200 });
    routes['POST /uploads/81/complete'] = () => json({ media: { id: 81, status: 'UPLOADED' } });
    routes['GET /uploads/81'] = () => json({ media: { id: 81, status: 'READY' } });
    let reply: Route = () => apiError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'details.neededBy', message: 'Use a date like 2026-12-01' }]);
    routes['POST /custom-work'] = (b) => reply(b);
    app(<CustomWorkForm />);
    await u.type(screen.getByLabelText('Your name'), 'Ravi Kumar');
    await u.type(screen.getByLabelText('Phone'), '+919847012345');
    await u.type(screen.getByLabelText('Email'), 'ravi@example.com');
    await u.type(screen.getByLabelText('Budget in ₹ (optional)'), '99');
    await u.type(screen.getByLabelText('How many (optional)'), '1.5');
    await u.type(screen.getByLabelText('Tell us what you’d like'), 'Preserve our wedding garland in teak.');
    await u.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expectFieldError('Budget in ₹ (optional)', 'At least ₹100'));
    expectFieldError('How many (optional)', 'Enter how many');
    await u.clear(screen.getByLabelText('Budget in ₹ (optional)'));
    await u.type(screen.getByLabelText('Budget in ₹ (optional)'), '4500');
    await u.clear(screen.getByLabelText('How many (optional)'));
    await u.upload(screen.getByLabelText(/^Photos/), new File(['x'], 'garland.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByText('garland.jpg: ready')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expectFieldError('Needed by (optional)', 'Use a date like 2026-12-01'));
    reply = () => json({ id: 2, received: true }, 201);
    await u.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByRole('heading', { name: 'Thank you, we’ve got your request' })).toBeTruthy();
    expect(sent('POST', '/custom-work').at(-1)!.body).toEqual({ name: 'Ravi Kumar', email: 'ravi@example.com', phone: '+919847012345', message: 'Preserve our wedding garland in teak.',
      details: { size: null, wood: null, quantity: null, budget: 4500, neededBy: null }, attachmentMediaIds: [81] });
  });
});
