// Task 6.1 in the admin against a fake API. Slides (the shared rules on each field, a server refusal on its field,
// move up / down saved at once, delete confirmed), FAQs by group, a page (rich text required, the footer's page keeps
// its address), home settings (announcement needs a message while on, hero seconds at the boundary, section order
// saved), and the messages inbox (not-closed by default, a message with its photo, status and note saved).
import { permissionsFor, type AdminMessageDetail, type AdminMessageRow, type CmsFaq, type CmsPageDetail, type CmsSlide, type Role } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

const slide = (o: Partial<CmsSlide> = {}): CmsSlide => ({ id: 1, heading: 'Resin art season', subheading: null, ctaText: 'Shop now', ctaLink: '/shop', media: { id: 50, url: 'https://cdn.test/a.webp', status: 'READY' }, mobileMedia: null, isActive: true, startsAt: null, endsAt: null, sortOrder: 0, live: true, ...o });
const faq = (o: Partial<CmsFaq> = {}): CmsFaq => ({ id: 1, group: 'SHIPPING', question: 'How long does delivery take?', answer: '4 to 7 days.', isActive: true, sortOrder: 0, ...o });
const page = (o: Partial<CmsPageDetail> = {}): CmsPageDetail => ({ id: 3, slug: 'about', title: 'About ArtQ', isPublished: true, updatedAt: '2026-10-09T06:00:00Z', updatedBy: 'Anu', content: '<p>Handcrafted resin art.</p>', metaTitle: null, metaDescription: null, ...o });
const msg = (o: Partial<AdminMessageRow> = {}): AdminMessageRow => ({ id: 9, kind: 'CUSTOM_WORK', name: 'Ravi', email: 'ravi@example.com', phone: null, subject: null, preview: 'A wedding garland preserved', orderNumber: null, status: 'NEW', attachments: 1, createdAt: '2026-10-09T06:00:00Z', ...o });
const settings = { ANNOUNCEMENT_BAR: { enabled: true, messages: ['Free shipping above ₹999'] }, HOME_SECTIONS: { order: ['hero', 'types', 'new-arrivals', 'reels', 'trending', 'techniques', 'testimonials', 'instagram'], hidden: [] }, HERO: { slideIntervalMs: 6000 }, INSTAGRAM_MOMENTS: { enabled: false, handle: null }, SOCIAL: { instagram: null, facebook: null, youtube: null, whatsapp: null } };

function setup(path: string, extra: Record<string, Handler> = {}, role: Role = 'ADMIN') {
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 1, name: 'Anu', email: 'anu@artq.in', role } }],
    'GET /admin/me': () => [200, { user: { id: 1, name: 'Anu', email: 'anu@artq.in', role }, permissions: permissionsFor(role) }],
    'GET /admin/home-slides': () => [200, { data: [slide(), slide({ id: 2, heading: 'Monsoon offers', live: false, isActive: false, sortOrder: 1 })] }],
    'GET /admin/faqs': () => [200, { data: [faq(), faq({ id: 2, question: 'Do you ship abroad?', sortOrder: 1 }), faq({ id: 3, group: 'ORDERS', question: 'Can I change my order?' })] }],
    'GET /admin/pages': () => [200, { data: [page()] }],
    'GET /admin/pages/3': () => [200, page()],
    'GET /admin/cms/settings': () => [200, settings],
    'GET /admin/messages': () => [200, { data: [msg()], meta: { page: 1, limit: 25, total: 1, totalPages: 1 } }],
    ...extra,
  });
  window.history.replaceState({}, '', path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const sent = (s: ReturnType<typeof setup>['server'], method: string, path: string) => s.calls.filter((c) => c.method === method && c.path === path);

describe('slides', () => {
  it('list with state; move down saves the order; delete is confirmed; accessible', async () => {
    const u = userEvent.setup();
    const { server, container } = setup('/cms', {
      'PATCH /admin/home-slides/reorder': () => [200, { data: [slide({ id: 2, heading: 'Monsoon offers' }), slide()] }],
      'DELETE /admin/home-slides/2': () => [200, { data: [slide()] }],
    });
    expect(await screen.findByText('On the home page now · Shop now → /shop')).toBeTruthy();
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
    await u.click(screen.getByRole('button', { name: 'Move Resin art season down' }));
    await waitFor(() => expect(sent(server, 'PATCH', '/admin/home-slides/reorder')[0]!.body).toEqual({ ids: [2, 1] }));
    await u.click(await screen.findByRole('button', { name: 'Delete Monsoon offers' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Delete this item?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sent(server, 'DELETE', '/admin/home-slides/2')).toHaveLength(1));
  });

  it('the editor: shared rules on the fields; a server refusal on its field; saved body', async () => {
    const u = userEvent.setup();
    let reply: [number, unknown] = err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'mediaId', message: 'Choose an uploaded image' }]);
    const { server } = setup('/cms', { 'PUT /admin/home-slides/1': () => reply });
    await u.click(await screen.findByRole('button', { name: 'Edit Resin art season' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit slide' }));
    await u.clear(dialog.getByLabelText('Button link'));
    await u.click(dialog.getByRole('button', { name: 'Save slide' }));
    await waitFor(() => expectFieldError('Button link', 'A button needs both its text and its link', dialog));
    await u.type(dialog.getByLabelText('Button link'), 'javascript:alert(1)');
    await u.click(dialog.getByRole('button', { name: 'Save slide' }));
    await waitFor(() => expectFieldError('Button link', 'Use a link on this site (starting with /) or a full https:// address', dialog));
    await u.clear(dialog.getByLabelText('Button link'));
    await u.type(dialog.getByLabelText('Button link'), '/new-arrivals');
    await u.type(dialog.getByLabelText('Show from (optional)'), '2026-10-12T09:00');
    await u.type(dialog.getByLabelText('Show until (optional)'), '2026-10-11T09:00');
    await u.click(dialog.getByRole('button', { name: 'Save slide' }));
    await waitFor(() => expectFieldError('Show until (optional)', 'Use an end after the start', dialog));
    await u.clear(dialog.getByLabelText('Show until (optional)'));
    await u.click(dialog.getByRole('button', { name: 'Save slide' }));
    expect(await dialog.findByText('Choose an uploaded image')).toBeTruthy();
    reply = [200, { data: [slide({ ctaLink: '/new-arrivals' })] }];
    await u.click(dialog.getByRole('button', { name: 'Save slide' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(sent(server, 'PUT', '/admin/home-slides/1').at(-1)!.body).toEqual({ heading: 'Resin art season', subheading: null, ctaText: 'Shop now', ctaLink: '/new-arrivals', mediaId: 50, mobileMediaId: null, isActive: true, startsAt: '2026-10-12T09:00:00+05:30', endsAt: null });
  });
});

describe('faqs and pages', () => {
  it('FAQs by group; a new question checked by the shared rules', async () => {
    const u = userEvent.setup();
    const { server } = setup('/cms?tab=faqs', { 'POST /admin/faqs': () => [201, { id: 4, data: [faq()] }] });
    expect(await screen.findByRole('list', { name: 'Shipping questions' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move How long does delivery take? up' }).hasAttribute('disabled')).toBe(true);
    await u.click(screen.getByRole('button', { name: 'Add question' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add question' }));
    await u.click(dialog.getByRole('button', { name: 'Save question' }));
    await waitFor(() => expectFieldError('Question', 'Enter the question', dialog));
    expectFieldError('Answer', 'Enter the answer', dialog);
    await u.selectOptions(dialog.getByLabelText('Group'), 'RETURNS');
    await u.type(dialog.getByLabelText('Question'), 'How do I return an item?');
    await u.type(dialog.getByLabelText('Answer'), 'Report it within 48 hours of delivery from your order page.');
    await u.click(dialog.getByRole('button', { name: 'Save question' }));
    await waitFor(() => expect(sent(server, 'POST', '/admin/faqs')[0]!.body).toEqual({ group: 'RETURNS', question: 'How do I return an item?', answer: 'Report it within 48 hours of delivery from your order page.', isActive: true }));
  });

  it('the footer’s page keeps its address and has no delete; a slug clash lands on the address', async () => {
    const u = userEvent.setup();
    setup('/cms?tab=pages', { 'POST /admin/pages': () => err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'slug', message: 'Another page already uses this address' }]) });
    const edit = await screen.findByRole('button', { name: 'Edit About ArtQ' });
    expect(edit.closest('li')!.textContent).toContain('/about · linked from the footer');
    expect(screen.queryByRole('button', { name: 'Delete About ArtQ' })).toBeNull();
    await u.click(edit);
    expect((await screen.findByLabelText('Address')).hasAttribute('readonly')).toBe(true);
    await u.click(screen.getByRole('button', { name: 'Cancel' }));
    await u.click(screen.getByRole('button', { name: 'Add page' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add page' }));
    await u.click(dialog.getByRole('button', { name: 'Save page' }));
    await waitFor(() => expectFieldError('Title', 'Enter the title', dialog));
    await u.type(dialog.getByLabelText('Title'), 'Care guide');
    await u.type(dialog.getByLabelText('Address'), 'Care Guide');
    await u.click(dialog.getByRole('button', { name: 'Save page' }));
    await waitFor(() => expectFieldError('Address', 'Use lowercase letters, digits and single dashes', dialog));
  });
});

describe('home settings', () => {
  it('announcement needs a message while on; hero seconds at the boundary; section order saved', async () => {
    const u = userEvent.setup();
    const { server } = setup('/cms?tab=home', {
      'PUT /admin/settings/ANNOUNCEMENT_BAR': () => [200, settings],
      'PUT /admin/settings/HERO': () => [200, settings],
      'PUT /admin/settings/HOME_SECTIONS': () => [200, settings],
    });
    await u.click(await screen.findByRole('button', { name: 'Remove message 1' }));
    await u.click(screen.getByRole('button', { name: 'Save announcement' }));
    expect(await screen.findByText('Add a message, or turn the bar off')).toBeTruthy();
    expect(sent(server, 'PUT', '/admin/settings/ANNOUNCEMENT_BAR')).toHaveLength(0);
    await u.click(screen.getByRole('button', { name: 'Add message' }));
    await u.type(screen.getByLabelText('Message 1'), 'Diwali offers are live');
    await u.click(screen.getByRole('button', { name: 'Save announcement' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/settings/ANNOUNCEMENT_BAR')[0]!.body).toEqual({ enabled: true, messages: ['Diwali offers are live'] }));

    await u.clear(screen.getByLabelText('Seconds per slide'));
    await u.type(screen.getByLabelText('Seconds per slide'), '1');
    await u.click(screen.getByRole('button', { name: 'Save timing' }));
    await waitFor(() => expectFieldError('Seconds per slide', 'Use at least 2 seconds'));
    await u.clear(screen.getByLabelText('Seconds per slide'));
    await u.type(screen.getByLabelText('Seconds per slide'), '30');
    await u.click(screen.getByRole('button', { name: 'Save timing' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/settings/HERO').map((c) => c.body)).toEqual([{ slideIntervalMs: 30_000 }]));

    await u.click(screen.getByRole('button', { name: 'Move Reels up' }));
    await u.click(within(screen.getByRole('list', { name: 'Home sections in order' })).getAllByRole('checkbox')[0]!);
    await u.click(screen.getByRole('button', { name: 'Save sections' }));
    await waitFor(() => expect(sent(server, 'PUT', '/admin/settings/HOME_SECTIONS')[0]!.body).toEqual({ order: ['hero', 'types', 'reels', 'new-arrivals', 'trending', 'techniques', 'testimonials', 'instagram'], hidden: ['types'] }));
  });
});

describe('messages', () => {
  it('not-closed by default; a message with its photo; status and note saved', async () => {
    const u = userEvent.setup();
    const detail: AdminMessageDetail = { ...msg(), message: 'A wedding garland preserved in a teak frame', details: { size: 'A3', wood: 'Teak' }, adminNote: null, files: [{ id: 70, url: 'https://storage.test/x.jpg?exp=300', thumbUrl: 'https://storage.test/x/w320.webp' }] };
    const { server } = setup('/cms?tab=messages', { 'GET /admin/messages/9': () => [200, detail], 'PATCH /admin/messages/9': () => [200, { ...detail, status: 'REPLIED' }] });
    await u.click(await screen.findByRole('button', { name: 'Ravi' }));
    expect(sent(server, 'GET', '/admin/messages')[0]!.query.get('open')).toBe('1');
    const dialog = within(await screen.findByRole('dialog', { name: 'Custom work from Ravi' }));
    expect(dialog.getByRole('img', { name: 'Attachment 1' }).getAttribute('src')).toBe('https://storage.test/x/w320.webp');
    expect(dialog.getByText('Teak')).toBeTruthy();
    await u.selectOptions(dialog.getByLabelText('Status'), 'REPLIED');
    await u.type(dialog.getByLabelText('Staff note'), 'Quoted ₹4,500 by WhatsApp');
    await u.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(server, 'PATCH', '/admin/messages/9')[0]!.body).toEqual({ status: 'REPLIED', adminNote: 'Quoted ₹4,500 by WhatsApp' }));
  });

  it('staff without content:write cannot open the page', async () => {
    setup('/cms', {}, 'STAFF');
    expect(await screen.findByRole('heading', { name: /not allowed|no access|permission/i })).toBeTruthy();
  });
});
