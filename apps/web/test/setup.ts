// jsdom gaps used by Radix / sonner, and a stand-in App Router (next/navigation) that tests can steer.
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => { cleanup(); nav.pathname = '/'; nav.push.mockClear(); nav.refresh.mockClear(); });
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
}
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
if (!('ResizeObserver' in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

export const nav = { pathname: '/', push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: nav.refresh }),
  useSearchParams: () => new URLSearchParams(),
}));
