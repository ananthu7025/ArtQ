// SEO bodies (task 6.4): one spelling per address, reserved shop addresses, targets only on this site, the limits at
// the boundary, and an override that sets nothing refused.
import { describe, expect, it } from 'vitest';
import { isReservedSeoPath, normalizeSeoPath, redirectBody, seoOverrideBody, seoResolveQuery, SEO_RESERVED_PREFIXES } from './seo-schemas.js';

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));

describe('addresses', () => {
  it('normalised: lower case, one slash, no trailing slash, no query or fragment', () => {
    expect(normalizeSeoPath('/Collections//Resin/')).toBe('/collections/resin');
    expect(normalizeSeoPath('/a?b=1#c')).toBe('/a');
    expect(normalizeSeoPath('/')).toBe('/');
    expect(normalizeSeoPath('///')).toBe('/');
  });
  it('reserved: the home page and every shop prefix (exact or below), not look-alikes', () => {
    expect(isReservedSeoPath('/')).toBe(true);
    for (const p of SEO_RESERVED_PREFIXES) { expect(isReservedSeoPath(p)).toBe(true); expect(isReservedSeoPath(`${p}/x`)).toBe(true); }
    expect(isReservedSeoPath('/shopping')).toBe(false);
    expect(isReservedSeoPath('/products/x')).toBe(false);   // the old shop's /products/… is redirectable; ours is /product/…
  });
});

describe('redirectBody', () => {
  it('normalises the old address; 301 by default; 302 allowed; a query in the target kept', () => {
    expect(redirectBody.parse({ fromPath: ' /Old-Page/ ', toPath: '/shop?type=resins' })).toEqual({ fromPath: '/old-page', toPath: '/shop?type=resins', statusCode: 301 });
    expect(redirectBody.parse({ fromPath: '/a', toPath: '/', statusCode: 302 }).statusCode).toBe(302);
  });
  it('refuses: empty, reserved, a query on the old address, itself, other sites, other codes, extra fields', () => {
    expect(issues(redirectBody.safeParse({}))).toEqual({ fromPath: 'Enter an address', toPath: 'Enter where it should go' });
    expect(issues(redirectBody.safeParse({ fromPath: '/category/x', toPath: '/shop' })).fromPath).toMatch(/served by the shop/);
    expect(issues(redirectBody.safeParse({ fromPath: '/a?x=1', toPath: '/shop' })).fromPath).toMatch(/no domain, \? or #/);
    expect(issues(redirectBody.safeParse({ fromPath: '/a', toPath: '/A/' }))).toEqual({ toPath: 'It can’t redirect to itself' });
    for (const toPath of ['//evil.example', 'https://evil.example', '/\\evil', 'shop', '/a b', '/a#b']) expect(redirectBody.safeParse({ fromPath: '/a', toPath }).success, toPath).toBe(false);
    expect(redirectBody.safeParse({ fromPath: '/a', toPath: '/b', statusCode: 307 }).success).toBe(false);
    expect(redirectBody.safeParse({ fromPath: '/a', toPath: '/b', note: 'x' }).success).toBe(false);
  });
  it('300 characters at most on both sides', () => {
    const at = `/${'a'.repeat(299)}`;
    expect(redirectBody.safeParse({ fromPath: at, toPath: at.replace(/a$/, 'b') }).success).toBe(true);
    expect(issues(redirectBody.safeParse({ fromPath: `${at}a`, toPath: `${at}b` }))).toEqual({ fromPath: 'Use at most 300 characters', toPath: 'Use at most 300 characters' });
  });
});

describe('seoOverrideBody', () => {
  it('at least one field; blanks become null; limits at the boundary', () => {
    expect(issues(seoOverrideBody.safeParse({ path: '/a', metaTitle: '  ' }))).toEqual({ metaTitle: 'Set at least one of title, description, canonical or “hide from search”' });
    expect(seoOverrideBody.parse({ path: '/A/', noindex: true })).toEqual({ path: '/a', metaTitle: null, metaDescription: null, canonical: null, noindex: true });
    expect(seoOverrideBody.safeParse({ path: '/', metaTitle: 't'.repeat(160), metaDescription: 'd'.repeat(320) }).success).toBe(true);
    expect(issues(seoOverrideBody.safeParse({ path: '/', metaTitle: 't'.repeat(161), metaDescription: 'd'.repeat(321) }))).toEqual({ metaTitle: 'Use at most 160 characters', metaDescription: 'Use at most 320 characters' });
  });
  it('canonical: a path here or an https address; nothing else', () => {
    for (const canonical of ['/shop', 'https://artq.in/shop', 'https://artq.in']) expect(seoOverrideBody.safeParse({ path: '/', canonical }).success, canonical).toBe(true);
    for (const canonical of ['http://artq.in', '//artq.in', 'javascript:alert(1)', 'shop', '/a b']) expect(seoOverrideBody.safeParse({ path: '/', canonical }).success, canonical).toBe(false);
  });
});

it('seoResolveQuery normalises; needs a leading slash', () => {
  expect(seoResolveQuery.parse({ path: '/Old/' })).toEqual({ path: '/old' });
  expect(seoResolveQuery.safeParse({ path: 'old' }).success).toBe(false);
  expect(seoResolveQuery.safeParse({ path: `/${'a'.repeat(600)}` }).success).toBe(false);
});
