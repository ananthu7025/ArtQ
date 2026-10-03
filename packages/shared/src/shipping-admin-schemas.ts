// Admin Shipping Rates (task 4.4, product.md §7 "Shipping Rates", §8.2). Shared by the API and the admin forms
// (validation rule). Money in paise, weights in grams.
import { z } from 'zod';
import { settingSchemas } from './settings.js';
import { pincodeField } from './storefront-schemas.js';

const MONEY_MAX = 1_000_000;   // ₹10,000 per shipment
const rate = (what: string) => z.number({ error: `Enter ${what}` }).int('Use whole paise').min(0, 'Use 0 or more').max(MONEY_MAX, 'At most ₹10,000');

export const SLABS_MAX = 20;
/** One weight band: up to `maxWeightG` grams costs `rate`. */
export const slabBody = z.strictObject({
  maxWeightG: z.number({ error: 'Enter a weight in grams' }).int('Use whole grams').min(1, 'Use at least 1 g').max(100_000, 'At most 100 kg'),
  rate: rate('a rate'),
});

/** POST /admin/shipping/zones and PUT /admin/shipping/zones/:id. Slabs replace the zone's slabs; lightest first. */
export const zoneBody = z.strictObject({
  name: z.string({ error: 'Enter a zone name' }).trim().min(1, 'Enter a zone name').max(80, 'Use at most 80 characters'),
  extraPerKg: rate('the extra rate per kg'),
  isActive: z.boolean().default(true),
  slabs: z.array(slabBody).min(1, 'Add at least one weight slab').max(SLABS_MAX, `At most ${SLABS_MAX} slabs`),
}).superRefine((b, ctx) => {
  b.slabs.forEach((s, i) => {
    const prev = b.slabs[i - 1];
    if (prev && s.maxWeightG <= prev.maxWeightG) ctx.addIssue({ code: 'custom', path: ['slabs', i, 'maxWeightG'], message: 'Must be heavier than the slab above' });
    if (prev && s.rate < prev.rate) ctx.addIssue({ code: 'custom', path: ['slabs', i, 'rate'], message: 'A heavier slab cannot cost less' });
  });
});
export type ZoneInput = z.input<typeof zoneBody>;

/** PUT /admin/shipping/state-zones: which zone each state ships at (null = not delivered). */
export const stateZonesBody = z.strictObject({
  assignments: z.array(z.strictObject({ stateId: z.number().int().positive(), zoneId: z.number().int().positive().nullable() })).min(1).max(60)
    .refine((a) => new Set(a.map((x) => x.stateId)).size === a.length, 'Each state only once'),
});

/** PUT /admin/shipping/settings: the SHIPPING setting. */
export const shippingSettingsBody = settingSchemas.SHIPPING;

/** PUT /admin/shipping/pincodes/:pincode: a pincode's own rule (overrides the default policy). */
export const pincodeRuleBody = z.strictObject({
  isServiceable: z.boolean({ error: 'Choose whether we deliver here' }),
  codAvailable: z.boolean({ error: 'Choose whether cash on delivery is available' }),
  eddMinDays: z.number({ error: 'Enter days' }).int('Use whole days').min(0, 'Use 0 or more').max(60, 'At most 60 days').nullable().default(null),
  eddMaxDays: z.number({ error: 'Enter days' }).int('Use whole days').min(0, 'Use 0 or more').max(60, 'At most 60 days').nullable().default(null),
  note: z.string().trim().max(200, 'Use at most 200 characters').transform((v) => v || null).nullable().default(null),
}).superRefine((b, ctx) => {
  if (b.codAvailable && !b.isServiceable) ctx.addIssue({ code: 'custom', path: ['codAvailable'], message: 'Cash on delivery needs delivery to this pincode' });
  if ((b.eddMinDays === null) !== (b.eddMaxDays === null)) ctx.addIssue({ code: 'custom', path: [b.eddMinDays === null ? 'eddMinDays' : 'eddMaxDays'], message: 'Enter both days, or neither (the default applies)' });
  if (b.eddMinDays !== null && b.eddMaxDays !== null && b.eddMaxDays < b.eddMinDays) ctx.addIssue({ code: 'custom', path: ['eddMaxDays'], message: 'Use at least the minimum' });
});
export type PincodeRuleInput = z.input<typeof pincodeRuleBody>;

export const pincodeListQuery = z.strictObject({
  q: z.string().trim().regex(/^\d{1,6}$/, 'Digits of a pincode').optional(),
  filter: z.enum(['blocked', 'no_cod', 'custom_days']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const PINCODE_CSV_MAX_ROWS = 20_000;
export const PINCODE_CSV_HEADER = ['pincode', 'deliverable', 'cod', 'edd_min_days', 'edd_max_days', 'note'] as const;
/** POST /admin/shipping/pincodes/import: the CSV text; `dryRun` checks without saving. All rows or none are saved. */
export const pincodeImportBody = z.strictObject({
  csv: z.string({ error: 'Choose a CSV file' }).min(1, 'The file is empty').max(2_000_000, 'The file is larger than 2 MB'),
  dryRun: z.boolean().default(false),
});
export type PincodeImportResult = { rows: number; created: number; updated: number; unchanged: number; errors: { line: number; message: string }[]; saved: boolean };

/** POST /admin/shipping/preview: what one shipment would cost to a pincode. */
export const shippingPreviewBody = z.strictObject({
  pincode: pincodeField,
  weightG: z.number({ error: 'Enter the packed weight in grams' }).int('Use whole grams').min(1, 'Use at least 1 g').max(100_000, 'At most 100 kg'),
  dimsCm: z.strictObject({
    length: z.number().positive().max(300), width: z.number().positive().max(300), height: z.number().positive().max(300),
  }).nullable().default(null),
  quantity: z.number().int().min(1, 'Use 1 or more').max(50, 'At most 50').default(1),
  shippingClass: z.enum(['STANDARD', 'BULKY', 'SURFACE_ONLY']).default('STANDARD'),
  subtotal: z.number({ error: 'Enter the order value' }).int('Use whole paise').min(0, 'Use 0 or more').max(100_000_000, 'At most ₹10,00,000'),
  couponDiscount: z.number().int().min(0).default(0),
  freeShippingCoupon: z.boolean().default(false),
}).refine((b) => b.couponDiscount <= b.subtotal, { path: ['couponDiscount'], message: 'Cannot be more than the order value' });

export type ZoneView = { id: number; name: string; extraPerKg: number; isActive: boolean; sortOrder: number; slabs: { maxWeightG: number; rate: number }[]; states: { id: number; name: string }[]; usedByOrders: boolean };
export type ShippingAdminView = {
  zones: ZoneView[];
  states: { id: number; name: string; zoneId: number | null }[];
  settings: z.output<typeof shippingSettingsBody>;
};
export type PincodeRuleView = {
  pincode: string; place: { district: string; state: string } | null; isServiceable: boolean; codAvailable: boolean; eddMinDays: number | null; eddMaxDays: number | null;
  note: string | null; source: string; updatedAt: string;
};
export type ShippingPreview = {
  pincode: string; place: { district: string; state: string } | null; zone: { id: number; name: string } | null; surfaceAvailable: boolean;
  serviceability: { serviceable: boolean; codAvailable: boolean; fromRule: boolean };
  quote: { ok: true; actualWeightG: number; chargeableWeightG: number; rate: number; shipping: number; freeShippingApplied: boolean; heavySurcharge: number; remainingForFree: number }
    | { ok: false; error: 'PINCODE_NOT_SERVICEABLE' | 'SHIPPING_RESTRICTED' | 'DIMENSIONS_REQUIRED' | 'NO_RATE' | 'NO_ZONE' | 'UNKNOWN_PINCODE' };
};

/** Whether surface transport reaches a pincode (D-7): false inside an air-only prefix. */
export const surfaceAvailable = (pincode: string, airOnlyPrefixes: readonly string[]) => !airOnlyPrefixes.some((p) => pincode.startsWith(p));
