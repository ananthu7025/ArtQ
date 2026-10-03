// Task 3.7: the search box with live suggestions (WAI-ARIA combobox) against a fake API.
import type { SearchSuggestions } from '@artq/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchForm } from '../components/layout/SearchForm';
import { API_URL } from '../lib/api';
import { nav } from './setup';

const SUGGEST: SearchSuggestions = {
  products: [{ id: 1, slug: 'epoxy', name: 'Ultra Clear Epoxy Resin', image: null, fromPrice: 49_900 }, { id: 2, slug: 'deep', name: 'Deep Pour Resin', image: null, fromPrice: 99_900 }],
  types: [{ slug: 'resins', name: 'Resins', href: '/type/resins' }],
  categories: [{ slug: 'art-resin', name: 'Art Resin', typeName: 'Resins' }],
};
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith(`${API_URL}/search/suggest?q=`)) return new Response(JSON.stringify(SUGGEST), { status: 200 });
    throw new TypeError('Failed to fetch');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const box = () => screen.getByRole('combobox', { name: 'Search products' });
const suggestCalls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/search/suggest'));

describe('search suggestions', () => {
  it('nothing for one character; from two characters, one request after typing stops (250 ms debounce)', async () => {
    const u = userEvent.setup();
    render(<SearchForm />);
    await u.type(box(), 'r');
    await new Promise((r) => setTimeout(r, 350));
    expect(suggestCalls()).toEqual([]);
    await u.type(box(), 'esin');
    await waitFor(() => expect(screen.getByRole('listbox', { name: 'Suggestions' }).hidden).toBe(false));
    expect(suggestCalls()).toEqual([`${API_URL}/search/suggest?q=resin`]);
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Ultra Clear Epoxy Resin₹499', 'Deep Pour Resin₹999', 'ResinsProduct type', 'Art ResinCategory in Resins', 'See all results for “resin”',
    ]);
    expect(screen.getByText('4 suggestions. Use the up and down arrows to choose.')).toBeTruthy();
  });

  it('↓/↑ move the highlight (aria-activedescendant, wrapping); Enter opens the highlighted suggestion', async () => {
    const u = userEvent.setup();
    const done = vi.fn();
    render(<SearchForm onDone={done} />);
    await u.type(box(), 'resin');
    await screen.findAllByRole('option');
    await u.keyboard('{ArrowDown}{ArrowDown}');
    const active = document.getElementById(box().getAttribute('aria-activedescendant')!)!;
    expect(active.textContent).toBe('Deep Pour Resin₹999');
    expect(active.getAttribute('aria-selected')).toBe('true');
    await u.keyboard('{ArrowUp}{ArrowUp}');
    expect(document.getElementById(box().getAttribute('aria-activedescendant')!)!.textContent).toBe('See all results for “resin”');   // wraps
    await u.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(nav.push).toHaveBeenCalledWith('/product/deep');
    expect(done).toHaveBeenCalled();
  });

  it('Enter with nothing highlighted searches; a click on a suggestion opens it; Esc closes only the list', async () => {
    const u = userEvent.setup();
    render(<SearchForm />);
    await u.type(box(), 'resin');
    await screen.findAllByRole('option');
    await u.keyboard('{Escape}');
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect((box() as HTMLInputElement).value).toBe('resin');
    await u.keyboard('{Enter}');
    expect(nav.push).toHaveBeenLastCalledWith('/search?q=resin');
    await u.type(box(), 'resin');
    await u.click((await screen.findAllByRole('option'))[2]!);
    expect(nav.push).toHaveBeenLastCalledWith('/type/resins');
  });

  it('empty search → the field message (shared rule), no navigation; suggestions failing stay silent; passes axe', async () => {
    const u = userEvent.setup();
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    const { container } = render(<SearchForm />);
    await u.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(box().getAttribute('aria-invalid')).toBe('true'));
    expect(document.getElementById('site-search-error')!.textContent).toBe('Type what you are looking for');
    expect(nav.push).not.toHaveBeenCalled();
    await u.type(box(), 'resin');
    await new Promise((r) => setTimeout(r, 350));
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((v) => v.id)).toEqual([]);
  });
});
