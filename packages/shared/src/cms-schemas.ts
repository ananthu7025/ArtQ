// CMS & Messages (task 6.1; api.md §4.10 "CMS", product.md §7.5 "CMS & Messages", database.md §3 content tables).
// Shared by the API and the admin forms (validation rule). The storefront reads the same records (home, task 3.3;
// FAQs and pages, task 6.2).
import { z } from 'zod';
import { HOME_SECTION_KEYS } from './storefront-schemas.js';

const opt = (max: number) => z.string().trim().max(max, `Use at most ${max.toLocaleString('en-IN')} characters`).transform((v) => v || null).nullable().default(null);
const req = (min: number, max: number, empty: string) => z.string({ error: empty }).trim().min(min, empty).max(max, `Use at most ${max.toLocaleString('en-IN')} characters`);
const id = z.number().int().positive();
const isoDateTime = z.iso.datetime({ offset: true, error: 'Use a date and time' });

/** A link on the site (`/shop`, `/type/resins?x=1`) or a full https address. */
export const linkField = z.string().trim().max(500, 'Use at most 500 characters')
  .refine((v) => (/^\/(?!\/)[^\s]*$/.test(v)) || /^https:\/\/[^\s/]+\.[^\s]+$/.test(v), 'Use a link on this site (starting with /) or a full https:// address');

export const slideBody = z.strictObject({
  heading: opt(160), subheading: opt(240), ctaText: opt(40),
  ctaLink: linkField.nullable().or(z.literal('').transform(() => null)).default(null),
  mediaId: z.number({ error: 'Choose an image' }).int().positive('Choose an image'),
  mobileMediaId: id.nullable().default(null),
  isActive: z.boolean().default(true),
  startsAt: isoDateTime.nullable().default(null),
  endsAt: isoDateTime.nullable().default(null),
}).superRefine((b, ctx) => {
  if ((b.ctaText === null) !== (b.ctaLink === null)) ctx.addIssue({ code: 'custom', path: [b.ctaText === null ? 'ctaText' : 'ctaLink'], message: 'A button needs both its text and its link' });
  if (b.startsAt && b.endsAt && Date.parse(b.endsAt) <= Date.parse(b.startsAt)) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Use an end after the start' });
});
export type SlideInput = z.input<typeof slideBody>;

export const instagramUrl = z.string().trim().max(500).regex(/^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._/?=&-]+$/, 'Use an instagram.com link');
export const reelBody = z.strictObject({
  title: opt(160),
  videoMediaId: z.number({ error: 'Choose a video' }).int().positive('Choose a video'),
  thumbnailMediaId: id.nullable().default(null),
  productId: id.nullable().default(null),
  instagramUrl: instagramUrl.nullable().or(z.literal('').transform(() => null)).default(null),
  isActive: z.boolean().default(true),
});
export type ReelInput = z.input<typeof reelBody>;

export const testimonialBody = z.strictObject({
  name: req(2, 120, 'Enter the customer’s name'),
  location: opt(80),
  quote: req(10, 600, 'Enter what they said (at least 10 characters)'),
  rating: z.number({ error: 'Choose a rating' }).int('Choose a rating').min(1, 'Use 1 to 5 stars').max(5, 'Use 1 to 5 stars'),
  avatarMediaId: id.nullable().default(null),
  productId: id.nullable().default(null),
  isActive: z.boolean().default(true),
});
export type TestimonialInput = z.input<typeof testimonialBody>;

export const FAQ_GROUPS = ['ORDERS', 'SHIPPING', 'PAYMENTS', 'PRODUCTS', 'RETURNS'] as const;
export const FAQ_GROUP_LABEL: Record<(typeof FAQ_GROUPS)[number], string> = { ORDERS: 'Orders', SHIPPING: 'Shipping', PAYMENTS: 'Payments', PRODUCTS: 'Products', RETURNS: 'Returns & refunds' };
export const faqBody = z.strictObject({
  group: z.enum(FAQ_GROUPS, { error: 'Choose a group' }),
  question: req(5, 300, 'Enter the question'),
  answer: req(5, 2000, 'Enter the answer'),
  isActive: z.boolean().default(true),
});
export type FaqInput = z.input<typeof faqBody>;

/** Slugs used by the storefront's fixed pages (task 6.2); a page with one of them is shown at that address. */
export const POLICY_SLUGS = ['about', 'terms', 'privacy-policy', 'shipping-policy', 'return-policy', 'cancellation-policy'] as const;
export const pageBody = z.strictObject({
  slug: z.string({ error: 'Enter the address' }).trim().toLowerCase().min(2, 'Use at least 2 characters').max(80, 'Use at most 80 characters')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and single dashes'),
  title: req(2, 160, 'Enter the title'),
  /** Rich text (the same editor and allowlist as product descriptions); cleaned by the API. */
  content: z.string({ error: 'Write the page' }).trim().min(1, 'Write the page').max(100_000, 'The page is too long (100,000 characters at most)'),
  metaTitle: opt(160), metaDescription: opt(320),
  isPublished: z.boolean().default(true),
});
export type PageInput = z.input<typeof pageBody>;

export const cmsReorderBody = z.strictObject({
  ids: z.array(z.number().int().positive()).min(1).max(500).refine((ids) => new Set(ids).size === ids.length, 'An item is listed twice'),
});

// ── Home settings edited here (content:write); the storage schemas in settings.ts accept these values ──
export const announcementBody = z.strictObject({
  enabled: z.boolean(),
  messages: z.array(req(1, 120, 'Enter the message')).max(5, 'At most 5 messages'),
}).refine((b) => !b.enabled || b.messages.length > 0, { path: ['messages'], message: 'Add a message, or turn the bar off' });
export const homeSectionsBody = z.strictObject({
  order: z.array(z.enum(HOME_SECTION_KEYS)).length(HOME_SECTION_KEYS.length, 'List every section once')
    .refine((o) => new Set(o).size === o.length, 'List every section once'),
  hidden: z.array(z.enum(HOME_SECTION_KEYS)).max(HOME_SECTION_KEYS.length).refine((h) => !h.includes('hero'), 'The hero can’t be hidden'),
});
export const heroBody = z.strictObject({
  slideIntervalMs: z.number({ error: 'Enter the seconds' }).int('Use whole milliseconds').min(2000, 'Use at least 2 seconds').max(30_000, 'Use at most 30 seconds'),
});
export const instagramBody = z.strictObject({
  enabled: z.boolean(),
  handle: z.string().trim().regex(/^@?[A-Za-z0-9._]{1,30}$/, 'Use the Instagram handle, e.g. @artq.studio').nullable().or(z.literal('').transform(() => null)),
}).refine((b) => !b.enabled || b.handle !== null, { path: ['handle'], message: 'Enter the handle, or turn the section off' });
const httpsUrl = z.string().trim().max(500).regex(/^https:\/\/[^\s]+$/, 'Use a full https:// link').nullable().or(z.literal('').transform(() => null));
export const socialBody = z.strictObject({
  instagram: httpsUrl, facebook: httpsUrl, youtube: httpsUrl,
  whatsapp: z.string().trim().regex(/^\+?\d{10,14}$/, 'Use the number with country code, e.g. +919847012345').nullable().or(z.literal('').transform(() => null)),
});
export const CMS_SETTING_BODIES = { ANNOUNCEMENT_BAR: announcementBody, HOME_SECTIONS: homeSectionsBody, HERO: heroBody, INSTAGRAM_MOMENTS: instagramBody, SOCIAL: socialBody } as const;
export type CmsSettingKey = keyof typeof CMS_SETTING_BODIES;
export const CMS_SETTING_KEYS = Object.keys(CMS_SETTING_BODIES) as CmsSettingKey[];

// ── Messages (contact form and custom work, task 6.2 fills them) ──
export const MESSAGE_STATUSES = ['NEW', 'IN_PROGRESS', 'REPLIED', 'CLOSED'] as const;
export const messageListQuery = z.strictObject({
  kind: z.enum(['CONTACT', 'CUSTOM_WORK']).optional(),
  status: z.enum(MESSAGE_STATUSES).optional(),
  /** Everything not closed yet. */
  open: z.literal('1').optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const messagePatchBody = z.strictObject({
  status: z.enum(MESSAGE_STATUSES).optional(),
  adminNote: z.string().trim().max(2000, 'Use at most 2,000 characters').transform((v) => v || null).nullable().optional(),
}).refine((b) => b.status !== undefined || b.adminNote !== undefined, { message: 'Nothing to change' });

// ── Views ──
export type CmsMedia = { id: number; url: string | null; status: string };
export type CmsSlide = { id: number; heading: string | null; subheading: string | null; ctaText: string | null; ctaLink: string | null; media: CmsMedia; mobileMedia: CmsMedia | null; isActive: boolean; startsAt: string | null; endsAt: string | null; sortOrder: number; live: boolean };
export type CmsReel = { id: number; title: string | null; video: CmsMedia; thumbnail: CmsMedia | null; product: { id: number; name: string } | null; instagramUrl: string | null; isActive: boolean; sortOrder: number };
export type CmsTestimonial = { id: number; name: string; location: string | null; quote: string; rating: number; avatar: CmsMedia | null; product: { id: number; name: string } | null; isActive: boolean; sortOrder: number };
export type CmsFaq = { id: number; group: (typeof FAQ_GROUPS)[number]; question: string; answer: string; isActive: boolean; sortOrder: number };
export type CmsPageRow = { id: number; slug: string; title: string; isPublished: boolean; updatedAt: string; updatedBy: string | null };
export type CmsPageDetail = CmsPageRow & { content: string; metaTitle: string | null; metaDescription: string | null };
export type AdminMessageRow = { id: number; kind: 'CONTACT' | 'CUSTOM_WORK'; name: string; email: string; phone: string | null; subject: string | null; preview: string; orderNumber: string | null; status: (typeof MESSAGE_STATUSES)[number]; attachments: number; createdAt: string };
export type AdminMessageDetail = AdminMessageRow & { message: string; details: Record<string, unknown> | null; adminNote: string | null; files: { id: number; url: string; thumbUrl: string | null }[] };
