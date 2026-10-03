// Shipping Rates forms (task 4.4): text in rupees/grams/days → the shared @artq/shared schemas (zoneBody,
// shippingSettingsBody, pincodeRuleBody, shippingPreviewBody), unchanged.
import { pincodeRuleBody, shippingPreviewBody, shippingSettingsBody, zoneBody, type PincodeRuleView, type ShippingAdminView, type ZoneView } from '@artq/shared';
import { convertedForm, fromPaise, optionalNumber, rupeeProblems, toPaise, wholeProblems, type FormatProblem } from '../../components/form-schema';

const money = (s: string) => (s.trim() === '' ? undefined : toPaise(s));
const whole = (s: string) => (s.trim() === '' ? undefined : Number(s.trim()));

// ── Zone ──
export type ZoneForm = { name: string; extraPerKg: string; isActive: boolean; slabs: { maxWeightG: string; rate: string }[] };
export const zoneToForm = (z: ZoneView | null): ZoneForm => z
  ? { name: z.name, extraPerKg: fromPaise(z.extraPerKg), isActive: z.isActive, slabs: z.slabs.map((s) => ({ maxWeightG: String(s.maxWeightG), rate: fromPaise(s.rate) })) }
  : { name: '', extraPerKg: '', isActive: true, slabs: [{ maxWeightG: '500', rate: '' }] };
export const zoneForm = convertedForm<ZoneForm, typeof zoneBody>(
  (v) => [
    ...rupeeProblems([[['extraPerKg'], v.extraPerKg], ...v.slabs.map((s, i): [(string | number)[], string] => [['slabs', i, 'rate'], s.rate])]),
    ...wholeProblems(v.slabs.map((s, i): [(string | number)[], string] => [['slabs', i, 'maxWeightG'], s.maxWeightG]), 'Use whole grams'),
  ],
  (v) => ({ name: v.name, extraPerKg: money(v.extraPerKg), isActive: v.isActive, slabs: v.slabs.map((s) => ({ maxWeightG: whole(s.maxWeightG), rate: money(s.rate) })) }),
  zoneBody,
);
export const zoneFields = (n: number) => ['name', 'extraPerKg', 'isActive', 'slabs', ...Array.from({ length: n }, (_, i) => [`slabs.${i}.maxWeightG`, `slabs.${i}.rate`]).flat()] as const;

// ── SHIPPING setting ──
type Settings = ShippingAdminView['settings'];
export type SettingsForm = {
  freeThreshold: string; packagingWeightG: string; volumetricDivisor: string; heavyCapG: string; heavyCapEnabled: boolean;
  defaultServiceable: boolean; defaultCod: boolean; estimatedDays: { min: string; max: string }; airOnlyPincodePrefixes: string;
};
export const settingsToForm = (s: Settings): SettingsForm => ({
  freeThreshold: fromPaise(s.freeThreshold), packagingWeightG: String(s.packagingWeightG), volumetricDivisor: String(s.volumetricDivisor), heavyCapG: String(s.heavyCapG),
  heavyCapEnabled: s.heavyCapEnabled, defaultServiceable: s.defaultServiceable, defaultCod: s.defaultCod,
  estimatedDays: { min: String(s.estimatedDays.min), max: String(s.estimatedDays.max) }, airOnlyPincodePrefixes: s.airOnlyPincodePrefixes.join(', '),
});
export const settingsForm = convertedForm<SettingsForm, typeof shippingSettingsBody>(
  (v) => [
    ...rupeeProblems([[['freeThreshold'], v.freeThreshold]]),
    ...wholeProblems([[['packagingWeightG'], v.packagingWeightG], [['volumetricDivisor'], v.volumetricDivisor], [['heavyCapG'], v.heavyCapG], [['estimatedDays', 'min'], v.estimatedDays.min], [['estimatedDays', 'max'], v.estimatedDays.max]]),
  ],
  (v) => ({
    freeThreshold: money(v.freeThreshold), packagingWeightG: whole(v.packagingWeightG), volumetricDivisor: whole(v.volumetricDivisor), heavyCapG: whole(v.heavyCapG),
    heavyCapEnabled: v.heavyCapEnabled, defaultServiceable: v.defaultServiceable, defaultCod: v.defaultCod,
    estimatedDays: { min: whole(v.estimatedDays.min), max: whole(v.estimatedDays.max) },
    airOnlyPincodePrefixes: v.airOnlyPincodePrefixes.split(/[\s,]+/).filter(Boolean),
  }),
  shippingSettingsBody,
  (path) => (path[0] === 'airOnlyPincodePrefixes' ? ['airOnlyPincodePrefixes'] : path),
);
export const SETTINGS_FIELDS = ['freeThreshold', 'packagingWeightG', 'volumetricDivisor', 'heavyCapG', 'heavyCapEnabled', 'defaultServiceable', 'defaultCod', 'estimatedDays.min', 'estimatedDays.max', 'airOnlyPincodePrefixes'] as const;

// ── Pincode rule ──
export type RuleForm = { pincode: string; isServiceable: boolean; codAvailable: boolean; eddMinDays: string; eddMaxDays: string; note: string };
export const ruleToForm = (r: PincodeRuleView | null): RuleForm => r
  ? { pincode: r.pincode, isServiceable: r.isServiceable, codAvailable: r.codAvailable, eddMinDays: r.eddMinDays === null ? '' : String(r.eddMinDays), eddMaxDays: r.eddMaxDays === null ? '' : String(r.eddMaxDays), note: r.note ?? '' }
  : { pincode: '', isServiceable: true, codAvailable: true, eddMinDays: '', eddMaxDays: '', note: '' };
const PINCODE = /^[1-9]\d{5}$/;
export const ruleForm = convertedForm<RuleForm, typeof pincodeRuleBody>(
  (v): FormatProblem[] => [
    ...(PINCODE.test(v.pincode.trim()) ? [] : [[['pincode'], 'Enter a 6-digit pincode'] as FormatProblem]),
    ...wholeProblems([[['eddMinDays'], v.eddMinDays], [['eddMaxDays'], v.eddMaxDays]], 'Use whole days'),
  ],
  (v) => ({ isServiceable: v.isServiceable, codAvailable: v.codAvailable, eddMinDays: optionalNumber(v.eddMinDays), eddMaxDays: optionalNumber(v.eddMaxDays), note: v.note }),
  pincodeRuleBody,
);

// ── Preview ──
export type PreviewForm = { pincode: string; weightG: string; length: string; width: string; height: string; quantity: string; shippingClass: 'STANDARD' | 'BULKY' | 'SURFACE_ONLY'; subtotal: string; couponDiscount: string; freeShippingCoupon: boolean };
export const EMPTY_PREVIEW: PreviewForm = { pincode: '', weightG: '', length: '', width: '', height: '', quantity: '1', shippingClass: 'STANDARD', subtotal: '', couponDiscount: '', freeShippingCoupon: false };
const CM = /^\d{1,3}(\.\d)?$/;
export const previewForm = convertedForm<PreviewForm, typeof shippingPreviewBody>(
  (v) => {
    const dims = [v.length, v.width, v.height];
    const some = dims.some((d) => d.trim() !== '');
    return [
      ...wholeProblems([[['weightG'], v.weightG], [['quantity'], v.quantity]]),
      ...rupeeProblems([[['subtotal'], v.subtotal], [['couponDiscount'], v.couponDiscount]]),
      ...(some ? (['length', 'width', 'height'] as const).filter((k) => !CM.test(v[k].trim()) || Number(v[k]) <= 0).map((k): FormatProblem => [[k], 'Use centimetres with at most one decimal (all three, or none)']) : []),
    ];
  },
  (v) => {
    const some = [v.length, v.width, v.height].some((d) => d.trim() !== '');
    return {
      pincode: v.pincode, weightG: whole(v.weightG), quantity: whole(v.quantity) ?? 1, shippingClass: v.shippingClass, subtotal: money(v.subtotal),
      couponDiscount: money(v.couponDiscount) ?? 0, freeShippingCoupon: v.freeShippingCoupon,
      dimsCm: some ? { length: Number(v.length), width: Number(v.width), height: Number(v.height) } : null,
    };
  },
  shippingPreviewBody,
  (path) => (path[0] === 'dimsCm' && path.length > 1 ? path.slice(1) : path),
);
