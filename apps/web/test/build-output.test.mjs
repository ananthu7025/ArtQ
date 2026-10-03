// Checks the production build output (run after `next build`; turbo runs build first).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const next = join(import.meta.dirname, '..', '.next');

/** Route keys that are API/route handlers rather than pages. */
export function handlerRoutes(manifest) {
  return Object.keys(manifest).filter((k) => /\/route$/.test(k) || k.startsWith('/api/'));
}

describe('handlerRoutes', () => {
  it('accepts page-only manifests', () => {
    expect(handlerRoutes({ '/page': '/', '/shop/[slug]/page': '/shop/[slug]' })).toEqual([]);
  });
  it('flags route handlers and api routes', () => {
    expect(handlerRoutes({ '/page': '/', '/api/cart/route': '/api/cart', '/feed.xml/route': '/feed.xml' })).toEqual(['/api/cart/route', '/feed.xml/route']);
  });
});

describe.skipIf(!existsSync(next))('next build output', () => {
  it('contains no route handlers (frontend only, architecture.md §1.1)', () => {
    const manifest = JSON.parse(readFileSync(join(next, 'app-path-routes-manifest.json'), 'utf8'));
    expect(handlerRoutes(manifest)).toEqual([]);
    expect(manifest['/page']).toBe('/');
  });
  it('prerenders the home page inside the layout shell, with shared-package output', () => {
    const html = readFileSync(join(next, 'server', 'app', 'index.html'), 'utf8');
    expect(html).toContain('lang="en-IN"');
    expect(html).toContain('ARTQ');
    // The announcement comes from the API, or from @artq/shared's defaults when the build cannot reach it.
    expect(html).toContain('Free shipping on orders above ₹1000');
    for (const landmark of ['<header', 'id="main"', '<footer', 'Skip to content', 'ALL RIGHTS RESERVED']) expect(html).toContain(landmark);
  });
  it('emits the design-token utilities and variables', () => {
    const dir = join(next, 'static', 'chunks');
    const css = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    expect(css).toMatch(/\.text-ink-900\{color:var\(--color-ink-900\)\}/);
    expect(css).toContain('--color-ink-900:#111827');
    expect(css).toMatch(/\.font-display\{font-family:var\(--font-display\)\}/);
  });
});
