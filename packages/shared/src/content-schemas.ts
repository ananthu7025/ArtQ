// Storefront content (task 6.2; api.md §3.1–3.2, product.md §5.11 "About, Contact, Custom work, FAQs, policy pages").
// Shared by the API and the storefront forms (validation rule).
import { z } from 'zod';
import { emailField, phoneField } from './auth-schemas.js';
import type { FAQ_GROUPS } from './cms-schemas.js';
import { FAQ_GROUP_LABEL } from './cms-schemas.js';

const req = (min: number, max: number, empty: string) => z.string({ error: empty }).trim().min(min, empty).max(max, `Use at most ${max.toLocaleString('en-IN')} characters`);
const opt = (max: number) => z.string().trim().max(max, `Use at most ${max.toLocaleString('en-IN')} characters`).transform((v) => v || null).nullable().default(null);
const optPhone = phoneField.nullable().or(z.literal('').transform(() => null)).default(null);

/** POST /contact (5 a minute per IP). */
export const contactBody = z.strictObject({
  name: req(2, 120, 'Enter your name'),
  email: emailField,
  phone: optPhone,
  subject: req(3, 160, 'Enter a subject'),
  message: req(10, 3000, 'Write your message (at least 10 characters)'),
  orderNumber: z.string().trim().toUpperCase().regex(/^AQ\d{3,15}$/, 'Enter an order number like AQ10234').nullable().or(z.literal('').transform(() => null)).default(null),
});
export type ContactInput = z.input<typeof contactBody>;

export const CUSTOM_WORK_PHOTOS_MAX = 4;
/** POST /custom-work (5 a minute per IP): the photos are this visitor's processed private uploads. */
export const customWorkBody = z.strictObject({
  name: req(2, 120, 'Enter your name'),
  email: emailField,
  phone: phoneField,
  details: z.strictObject({
    size: opt(80), wood: opt(80),
    quantity: z.number({ error: 'Enter how many' }).int('Use a whole number').min(1, 'At least 1').max(500, 'At most 500').nullable().default(null),
    budget: z.number({ error: 'Enter your budget in rupees' }).int('Use whole rupees').min(100, 'At least ₹100').max(10_000_000, 'At most ₹1,00,00,000').nullable().default(null),
    neededBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-01').nullable().or(z.literal('').transform(() => null)).default(null),
  }),
  message: req(10, 3000, 'Describe what you’d like (at least 10 characters)'),
  attachmentMediaIds: z.array(z.number().int().positive()).max(CUSTOM_WORK_PHOTOS_MAX, `At most ${CUSTOM_WORK_PHOTOS_MAX} photos`).default([])
    .refine((ids) => new Set(ids).size === ids.length, 'Each photo only once'),
});
export type CustomWorkInput = z.input<typeof customWorkBody>;

/** POST /uploads/presign (custom-work photos): images up to 8 MB. */
export const uploadPresignBody = z.strictObject({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().toLowerCase().max(120),
  size: z.number().int().positive(),
});

/** GET /pages/:slug: a published content page (HTML cleaned by the API). */
export type PublicPage = { slug: string; title: string; content: string; metaTitle: string | null; metaDescription: string | null; updatedAt: string };
/** GET /faqs: active questions by group, in order; empty groups left out. */
export type FaqView = { groups: { group: (typeof FAQ_GROUPS)[number]; label: string; items: { question: string; answer: string }[] }[] };
export const faqGroupLabel = (g: (typeof FAQ_GROUPS)[number]) => FAQ_GROUP_LABEL[g];
