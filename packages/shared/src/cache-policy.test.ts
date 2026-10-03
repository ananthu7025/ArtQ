import { describe, expect, it } from 'vitest';
import { isPublicCacheable, PUBLIC_CACHE_CONTROL } from './cache-policy.js';

describe('public cache allow-list (architecture.md §6.1)', () => {
  it.each([
    '/home', '/navigation', '/settings/public', '/types', '/types/resins', '/types/resins/categories', '/categories', '/categories/mica-powder',
    '/techniques', '/techniques/coasters', '/products', '/products?type=pigments&page=2', '/products/epoxy-resin-21', '/pages/about',
    '/faqs', '/testimonials', '/reels', '/seo/sitemap-entries', '/seo/resolve?path=/old',
    '/NAVIGATION', '/products/', '/navigation#x',
  ])('%s is publicly cacheable', (p) => { expect(isPublicCacheable(p)).toBe(true); });

  it.each([
    // personal or live: never shared-cached
    '/products/epoxy-resin-21/availability', '/pincodes/682001/serviceability', '/pincodes/682001',
    '/auth/login', '/auth/refresh', '/me', '/me/orders', '/cart', '/cart/items', '/checkout', '/orders/AQ1001', '/orders/AQ1001/uploads/presign',
    '/admin/products', '/admin/navigation', '/uploads/presign', '/newsletter/subscribe', '/webhooks/razorpay',
    // look-alikes
    '/navigation/extra', '/settings', '/settings/private', '/homepage', '/pages', '/seo', '/products//x', '/v1/navigation', '',
  ])('%s is never publicly cacheable', (p) => { expect(isPublicCacheable(p)).toBe(false); });

  it('the header value: no browser caching, 60 s in shared caches, 60 s stale while revalidating', () => {
    expect(PUBLIC_CACHE_CONTROL).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=60');
  });
});
