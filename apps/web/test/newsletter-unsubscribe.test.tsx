// Task 6.3: the unsubscribe page. A malformed link is refused without asking the API; an unknown one says the link is
// not valid; a good one shows the masked address and only unsubscribes on the button; the API down keeps the button
// usable; an already unsubscribed address says so; the page is not indexed.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UnsubscribePage, { metadata } from '../app/newsletter/unsubscribe/page';
import { UnsubscribeView } from '../components/newsletter/UnsubscribeView';
import { API_URL } from '../lib/api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const TOKEN = 'a'.repeat(32);
let routes: Record<string, (body: unknown) => Response>;
let calls: { method: string; path: string; body: unknown }[];
beforeEach(() => {
  calls = []; routes = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.slice(API_URL.length);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const r = routes[`${method} ${path}`];
    if (!r) throw new TypeError('Failed to fetch');
    return r(body);
  }));
});
afterEach(() => vi.unstubAllGlobals());
const INVALID = /This unsubscribe link isn’t valid/;

describe('unsubscribe page', () => {
  it('shows the masked address; nothing changes until the button; then confirms (no robots, no referrer)', async () => {
    const u = userEvent.setup();
    routes[`GET /newsletter/unsubscribe?token=${TOKEN}`] = () => json({ email: 'a***@example.com', status: 'SUBSCRIBED' });
    routes['POST /newsletter/unsubscribe'] = () => json({ email: 'a***@example.com', status: 'UNSUBSCRIBED' });
    const { container } = render(await UnsubscribePage({ searchParams: Promise.resolve({ token: TOKEN }) }));
    expect(await screen.findByText(/Stop sending the ArtQ newsletter to/)).toBeTruthy();
    expect(screen.getByText('a***@example.com')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } }).then((r) => expect(r.violations.map((v) => v.id)).toEqual([]));
    await u.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByText(/is unsubscribed\. You won’t get our newsletter any more\./)).toBeTruthy();
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/newsletter/unsubscribe', body: { token: TOKEN } });
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe('no-referrer');
  });

  it('a missing, repeated or malformed token is refused without calling the API', async () => {
    for (const token of [undefined, ['x', 'y'], 'nope', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) {
      const { unmount } = render(await UnsubscribePage({ searchParams: Promise.resolve({ token }) }));
      expect(screen.getByRole('alert').textContent).toMatch(INVALID);
      unmount();
    }
    expect(calls).toEqual([]);
  });

  it('an unknown link says it is not valid; an address already unsubscribed says so', async () => {
    routes[`GET /newsletter/unsubscribe?token=${TOKEN}`] = () => json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    const { unmount } = render(<UnsubscribeView token={TOKEN} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(INVALID);
    unmount();
    routes[`GET /newsletter/unsubscribe?token=${TOKEN}`] = () => json({ email: 'a***@example.com', status: 'UNSUBSCRIBED' });
    render(<UnsubscribeView token={TOKEN} />);
    expect(await screen.findByText(/is unsubscribed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unsubscribe' })).toBeNull();
  });

  it('the API down: the load says so; a failed unsubscribe keeps the button to try again', async () => {
    const { unmount } = render(<UnsubscribeView token={TOKEN} />);
    expect((await screen.findByRole('alert')).textContent).toBe('We could not reach the store. Check your connection and try again.');
    unmount();
    const u = userEvent.setup();
    routes[`GET /newsletter/unsubscribe?token=${TOKEN}`] = () => json({ email: 'a***@example.com', status: 'SUBSCRIBED' });
    routes['POST /newsletter/unsubscribe'] = () => json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } }, 500);
    render(<UnsubscribeView token={TOKEN} />);
    await u.click(await screen.findByRole('button', { name: 'Unsubscribe' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong. Please try again.');
    routes['POST /newsletter/unsubscribe'] = () => json({ email: 'a***@example.com', status: 'UNSUBSCRIBED' });
    await u.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByText(/is unsubscribed/)).toBeTruthy();
  });
});
