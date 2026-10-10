// Settings values (database.md §3.13). One strict schema per key: the seed validates its defaults with these and the
// admin settings endpoints (task 2.x) validate updates with the same schemas. Money in paise.
import { z } from 'zod';

const paise = z.number().int().min(0);
const gstStateCode = z.string().regex(/^\d{2}$/);

export const settingSchemas = {
  STORE_INFO: z.strictObject({
    name: z.string().min(1),
    legalName: z.string().nullable(),
    gstin: z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).nullable(),
    address: z.string().nullable(),
    stateCode: gstStateCode,
    phone: z.string().nullable(),
    email: z.email().nullable(),
    whatsapp: z.string().nullable(),
  }),
  ANNOUNCEMENT_BAR: z.strictObject({ enabled: z.boolean(), messages: z.array(z.string().min(1).max(120)).max(5) }),
  HOME_SECTIONS: z.strictObject({ order: z.array(z.string().min(1)), hidden: z.array(z.string().min(1)) }),
  HERO: z.strictObject({ slideIntervalMs: z.number().int().min(2000).max(30_000) }),
  INSTAGRAM_MOMENTS: z.strictObject({ enabled: z.boolean(), handle: z.string().nullable() }),
  SOCIAL: z.strictObject({ instagram: z.url().nullable(), facebook: z.url().nullable(), youtube: z.url().nullable(), whatsapp: z.string().nullable() }),
  /** Edited on the admin Shipping Rates page (task 4.4); the same schema validates the form and the API. */
  SHIPPING: z.strictObject({
    freeThreshold: z.number({ error: 'Enter an amount' }).int('Use whole paise').min(0, 'Use 0 or more').max(10_000_000, 'At most ₹1,00,000'),
    packagingWeightG: z.number({ error: 'Enter a weight in grams' }).int('Use whole grams').min(0, 'Use 0 or more').max(5000, 'At most 5,000 g'),
    volumetricDivisor: z.number({ error: 'Enter the divisor' }).int('Use a whole number').min(1000, 'Use at least 1,000').max(10_000, 'At most 10,000'),
    heavyCapG: z.number({ error: 'Enter a weight in grams' }).int('Use whole grams').min(500, 'Use at least 500 g').max(100_000, 'At most 100 kg'),
    heavyCapEnabled: z.boolean(),
    defaultServiceable: z.boolean(),
    defaultCod: z.boolean(),
    estimatedDays: z.strictObject({
      min: z.number({ error: 'Enter days' }).int('Use whole days').min(0, 'Use 0 or more').max(60, 'At most 60 days'),
      max: z.number({ error: 'Enter days' }).int('Use whole days').min(0, 'Use 0 or more').max(60, 'At most 60 days'),
    }).refine((d) => d.min <= d.max, { path: ['max'], message: 'Use at least the minimum' }),
    /**
     * Pincode prefixes that surface transport cannot reach (decision D-7): SURFACE_ONLY items (resin) cannot ship there.
     * Defaults: Andaman & Nicobar (744) and Lakshadweep (68255), for the owner and courier to confirm.
     */
    airOnlyPincodePrefixes: z.array(z.string().trim().regex(/^[1-9]\d{1,5}$/, 'Use 2 to 6 digits of a pincode, e.g. 744'))
      .max(50, 'At most 50 prefixes')
      .refine((l) => new Set(l).size === l.length, 'Each prefix only once')
      .default(['744', '68255']),
  }),
  PAYMENT: z.strictObject({
    razorpayEnabled: z.boolean(),
    codEnabled: z.boolean(),
    codFee: paise,
    codMin: paise,
    codMax: paise,
    pendingExpiryMinutes: z.number().int().min(5).max(120),
    autoRefundExcessCapture: z.boolean(),
  }).refine((p) => p.codMin <= p.codMax, 'codMin must not exceed codMax'),
  ORDER: z.strictObject({
    customerCancelUntil: z.enum(['UNFULFILLED']),
    returnWindowHours: z.number().int().min(0),
    completeAfterDays: z.number().int().min(1),
  }),
  TAX: z.strictObject({ pricesIncludeTax: z.literal(true), shippingTaxRule: z.enum(['CA_DECISION', 'TAXED', 'EXEMPT']), invoiceAt: z.enum(['DISPATCH']) }),
  NOTIFY: z.strictObject({ adminEmails: z.array(z.email()), dailySummary: z.boolean(), lowStockEmail: z.boolean() }),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingSchemas)[K]>;
export const SETTING_KEYS = Object.keys(settingSchemas) as SettingKey[];

/** Keys readable without authentication (the API still strips private fields such as STORE_INFO contact details as needed). */
export const PUBLIC_SETTING_KEYS: readonly SettingKey[] = ['STORE_INFO', 'ANNOUNCEMENT_BAR', 'HOME_SECTIONS', 'HERO', 'INSTAGRAM_MOMENTS', 'SOCIAL', 'SHIPPING', 'PAYMENT', 'ORDER'];

/** Launch defaults (database.md §3.13). Unknown business values are null until the client supplies them. */
export const DEFAULT_SETTINGS: { [K in SettingKey]: SettingValue<K> } = {
  STORE_INFO: { name: 'ArtQ', legalName: null, gstin: null, address: null, stateCode: '32', phone: null, email: null, whatsapp: null },
  ANNOUNCEMENT_BAR: { enabled: true, messages: ['Shipping all over India', 'Free shipping on orders above ₹1000'] },
  // product.md §5.1 order. 'reels' is "Trending now"; 'trending' is its fallback product grid (shown only without reels).
  HOME_SECTIONS: { order: ['hero', 'types', 'new-arrivals', 'reels', 'trending', 'techniques', 'testimonials', 'instagram'], hidden: [] },
  HERO: { slideIntervalMs: 6000 },
  INSTAGRAM_MOMENTS: { enabled: false, handle: null },
  SOCIAL: { instagram: null, facebook: null, youtube: null, whatsapp: null },
  SHIPPING: { freeThreshold: 100_000, packagingWeightG: 150, volumetricDivisor: 5000, heavyCapG: 10_000, heavyCapEnabled: true, defaultServiceable: true, defaultCod: true, estimatedDays: { min: 4, max: 7 }, airOnlyPincodePrefixes: ['744', '68255'] },
  PAYMENT: { razorpayEnabled: true, codEnabled: true, codFee: 4000, codMin: 20_000, codMax: 500_000, pendingExpiryMinutes: 30, autoRefundExcessCapture: true },
  ORDER: { customerCancelUntil: 'UNFULFILLED', returnWindowHours: 48, completeAfterDays: 7 },
  TAX: { pricesIncludeTax: true, shippingTaxRule: 'CA_DECISION', invoiceAt: 'DISPATCH' },
  NOTIFY: { adminEmails: [], dailySummary: true, lowStockEmail: true },
};

/** Parses a stored value for `key`; throws a ZodError when it does not match. */
export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return settingSchemas[key].parse(value) as SettingValue<K>;
}
