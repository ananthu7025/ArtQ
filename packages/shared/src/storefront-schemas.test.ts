import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings.js';
import { DEFAULT_PUBLIC_SETTINGS, newsletterSubscribeBody, searchForm, toPublicSettings, whatsappHref } from './storefront-schemas.js';

describe('whatsappHref', () => {
  it.each([
    ['+91 98470 12345', 'https://wa.me/919847012345'],
    ['919847012345', 'https://wa.me/919847012345'],
    ['9847012345', 'https://wa.me/919847012345'],       // 10 digits → India
    ['09847012345', 'https://wa.me/919847012345'],      // trunk 0 dropped
    ['+44 20 7946 0958', 'https://wa.me/442079460958'],
  ])('%s → %s', (n, href) => { expect(whatsappHref(n)).toBe(href); });
  it('prefills text, encoded', () => { expect(whatsappHref('9847012345', 'Hi & hello?')).toBe('https://wa.me/919847012345?text=Hi%20%26%20hello%3F'); });
  it.each([null, undefined, '', 'call us', '12345', '+1234567890123456'])('%s → null', (n) => { expect(whatsappHref(n)).toBeNull(); });
});

describe('newsletterSubscribeBody', () => {
  it('trims, defaults the source to footer, refuses unknown sources and keys', () => {
    expect(newsletterSubscribeBody.parse({ email: '  a@b.in ' })).toEqual({ email: 'a@b.in', source: 'footer' });
    expect(newsletterSubscribeBody.safeParse({ email: 'a@b.in', source: 'popup' }).success).toBe(false);
    expect(newsletterSubscribeBody.safeParse({ email: 'a@b.in', name: 'x' }).success).toBe(false);
  });
  it('160 characters pass, 161 fail', () => {
    expect(newsletterSubscribeBody.safeParse({ email: `${'a'.repeat(148)}@example.com` }).success).toBe(true);
    expect(newsletterSubscribeBody.safeParse({ email: `${'a'.repeat(149)}@example.com` }).error?.issues[0]?.message).toBe('Use at most 160 characters');
  });
});

describe('searchForm', () => {
  it('1–100 characters after trimming', () => {
    expect(searchForm.parse({ q: '  mica ' })).toEqual({ q: 'mica' });
    expect(searchForm.safeParse({ q: '   ' }).error?.issues[0]?.message).toBe('Type what you are looking for');
    expect(searchForm.safeParse({ q: 'x'.repeat(100) }).success).toBe(true);
    expect(searchForm.safeParse({ q: 'x'.repeat(101) }).error?.issues[0]?.message).toBe('Use at most 100 characters');
  });
});

describe('toPublicSettings', () => {
  it('defaults: what the storefront shows before the owner changes anything; no GSTIN/address/private keys', () => {
    expect(DEFAULT_PUBLIC_SETTINGS.announcement.messages).toEqual(['Shipping all over India', 'Free shipping on orders above ₹1000']);
    expect(Object.keys(DEFAULT_PUBLIC_SETTINGS.store).sort()).toEqual(['email', 'name', 'phone', 'whatsapp']);
    expect(JSON.stringify(DEFAULT_PUBLIC_SETTINGS)).not.toMatch(/gstin|adminEmails|shippingTaxRule|packagingWeightG/);
  });
  it('the store WhatsApp wins over the social one; the social one is the fallback', () => {
    const get = (store: string | null, social: string | null) => toPublicSettings((k) => (k === 'STORE_INFO' ? { ...DEFAULT_SETTINGS.STORE_INFO, whatsapp: store } : k === 'SOCIAL' ? { ...DEFAULT_SETTINGS.SOCIAL, whatsapp: social } : DEFAULT_SETTINGS[k]) as never);
    expect(get('111', '222').store.whatsapp).toBe('111');
    expect(get(null, '222').store.whatsapp).toBe('222');
    expect(get(null, null).store.whatsapp).toBeNull();
  });
});
