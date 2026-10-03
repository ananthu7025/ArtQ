// Storefront request schemas and public response shapes (api.md §3.1–§3.2). One schema per request, imported by the API
// route and the storefront form (validation rule, CLAUDE.md).
import { z } from 'zod';
import { emailField } from './auth-schemas.js';
import { DEFAULT_SETTINGS, type SettingKey, type SettingValue } from './settings.js';

/** Where a newsletter sign-up came from (`newsletter_subscribers.source`, varchar 20). */
export const NEWSLETTER_SOURCES = ['footer', 'checkout', 'account'] as const;
export const newsletterSubscribeBody = z.strictObject({ email: emailField, source: z.enum(NEWSLETTER_SOURCES).default('footer') });
export type NewsletterSubscribeBody = z.input<typeof newsletterSubscribeBody>;

/** The search box (header overlay, /search page) and GET /v1/search?q= (task 3.7) share this rule. */
export const SEARCH_QUERY_MAX = 100;
export const searchQueryField = z.string().trim().min(1, 'Type what you are looking for').max(SEARCH_QUERY_MAX, `Use at most ${SEARCH_QUERY_MAX} characters`);
export const searchForm = z.strictObject({ q: searchQueryField });

/** GET /v1/navigation: active types shown in the menu, each with its active categories, in admin order. */
export type NavigationCategory = { id: number; name: string; slug: string };
export type NavigationType = { id: number; name: string; slug: string; href: string; categories: NavigationCategory[] };
export type Navigation = { types: NavigationType[] };

/** GET /v1/settings/public: only what pages need; contact details the owner has not filled in are null. */
export type PublicSettings = {
  store: { name: string; phone: string | null; email: string | null; whatsapp: string | null };
  announcement: { enabled: boolean; messages: string[] };
  social: { instagram: string | null; facebook: string | null; youtube: string | null; whatsapp: string | null };
  shipping: { freeThreshold: number; estimatedDays: { min: number; max: number } };
  payment: { codEnabled: boolean; codFee: number; codMin: number; codMax: number };
  order: { returnWindowHours: number };
  home: { order: string[]; hidden: string[]; heroSlideIntervalMs: number; instagram: { enabled: boolean; handle: string | null } };
};

/** Builds the public view from settings values (the API passes stored values; pages fall back to the defaults). */
export function toPublicSettings(get: <K extends SettingKey>(key: K) => SettingValue<K>): PublicSettings {
  const store = get('STORE_INFO'), ann = get('ANNOUNCEMENT_BAR'), social = get('SOCIAL'), ship = get('SHIPPING'), pay = get('PAYMENT');
  const sections = get('HOME_SECTIONS'), insta = get('INSTAGRAM_MOMENTS');
  return {
    // GSTIN, legal name and address belong on invoices, not in every page's payload.
    store: { name: store.name, phone: store.phone, email: store.email, whatsapp: store.whatsapp ?? social.whatsapp },
    announcement: { enabled: ann.enabled, messages: ann.messages },
    social,
    shipping: { freeThreshold: ship.freeThreshold, estimatedDays: ship.estimatedDays },
    payment: { codEnabled: pay.codEnabled, codFee: pay.codFee, codMin: pay.codMin, codMax: pay.codMax },
    order: { returnWindowHours: get('ORDER').returnWindowHours },
    home: { order: sections.order, hidden: sections.hidden, heroSlideIntervalMs: get('HERO').slideIntervalMs, instagram: { enabled: insta.enabled, handle: insta.handle } },
  };
}
export const DEFAULT_PUBLIC_SETTINGS: PublicSettings = toPublicSettings((key) => DEFAULT_SETTINGS[key]);

/** WhatsApp chat link for a stored number ("+91 98470 12345", "919847012345", "09847012345"); null when it is not a usable Indian or international number. */
export function whatsappHref(number: string | null | undefined, text?: string): string | null {
  if (!number) return null;
  let digits = number.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (/^0\d{10}$/.test(digits)) digits = `91${digits.slice(1)}`;
  else if (/^\d{10}$/.test(digits)) digits = `91${digits}`;
  if (!/^\d{11,15}$/.test(digits)) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
