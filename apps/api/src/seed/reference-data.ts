// Reference data seeded by task 1.3 (database.md §10). Money in paise.

export type ZoneKey = 'KERALA' | 'SOUTH' | 'REST' | 'REMOTE';

/** Shipping zones and default slabs, product.md §8.2 (editable; decision D-13). */
export const ZONES: { key: ZoneKey; name: string; sortOrder: number; extraPerKg: number; slabs: { maxWeightG: number; rate: number }[] }[] = [
  { key: 'KERALA', name: 'Kerala', sortOrder: 1, extraPerKg: 4000, slabs: slabs(5000, 7000, 11_000, 22_000) },
  { key: 'SOUTH', name: 'Rest of South', sortOrder: 2, extraPerKg: 4500, slabs: slabs(6000, 8500, 13_000, 26_000) },
  { key: 'REST', name: 'Rest of India', sortOrder: 3, extraPerKg: 5500, slabs: slabs(7000, 10_000, 15_000, 30_000) },
  { key: 'REMOTE', name: 'NE / J&K / islands', sortOrder: 4, extraPerKg: 7500, slabs: slabs(10_000, 14_000, 20_000, 40_000) },
];
function slabs(r500: number, r1000: number, r2000: number, r5000: number) {
  return [{ maxWeightG: 500, rate: r500 }, { maxWeightG: 1000, rate: r1000 }, { maxWeightG: 2000, rate: r2000 }, { maxWeightG: 5000, rate: r5000 }];
}

export const INDIA = { name: 'India', iso2: 'IN', phoneCode: '+91' };

/**
 * 28 states + 8 union territories with GST state codes (code 25 merged into 26 in 2020; 28 is pre-2014 Andhra Pradesh, unused).
 * Zone mapping: South = AP, KA, PY, TN, TS; Remote = the eight north-eastern states, J&K, Ladakh, Andaman & Nicobar,
 * Lakshadweep. This mapping is a proposal for the owner to confirm with the courier (D-13); admins can change it.
 */
export const STATES: { name: string; code: string; gstCode: string; zone: ZoneKey }[] = [
  { name: 'Jammu and Kashmir', code: 'JK', gstCode: '01', zone: 'REMOTE' },
  { name: 'Himachal Pradesh', code: 'HP', gstCode: '02', zone: 'REST' },
  { name: 'Punjab', code: 'PB', gstCode: '03', zone: 'REST' },
  { name: 'Chandigarh', code: 'CH', gstCode: '04', zone: 'REST' },
  { name: 'Uttarakhand', code: 'UK', gstCode: '05', zone: 'REST' },
  { name: 'Haryana', code: 'HR', gstCode: '06', zone: 'REST' },
  { name: 'Delhi', code: 'DL', gstCode: '07', zone: 'REST' },
  { name: 'Rajasthan', code: 'RJ', gstCode: '08', zone: 'REST' },
  { name: 'Uttar Pradesh', code: 'UP', gstCode: '09', zone: 'REST' },
  { name: 'Bihar', code: 'BR', gstCode: '10', zone: 'REST' },
  { name: 'Sikkim', code: 'SK', gstCode: '11', zone: 'REMOTE' },
  { name: 'Arunachal Pradesh', code: 'AR', gstCode: '12', zone: 'REMOTE' },
  { name: 'Nagaland', code: 'NL', gstCode: '13', zone: 'REMOTE' },
  { name: 'Manipur', code: 'MN', gstCode: '14', zone: 'REMOTE' },
  { name: 'Mizoram', code: 'MZ', gstCode: '15', zone: 'REMOTE' },
  { name: 'Tripura', code: 'TR', gstCode: '16', zone: 'REMOTE' },
  { name: 'Meghalaya', code: 'ML', gstCode: '17', zone: 'REMOTE' },
  { name: 'Assam', code: 'AS', gstCode: '18', zone: 'REMOTE' },
  { name: 'West Bengal', code: 'WB', gstCode: '19', zone: 'REST' },
  { name: 'Jharkhand', code: 'JH', gstCode: '20', zone: 'REST' },
  { name: 'Odisha', code: 'OD', gstCode: '21', zone: 'REST' },
  { name: 'Chhattisgarh', code: 'CG', gstCode: '22', zone: 'REST' },
  { name: 'Madhya Pradesh', code: 'MP', gstCode: '23', zone: 'REST' },
  { name: 'Gujarat', code: 'GJ', gstCode: '24', zone: 'REST' },
  { name: 'Dadra and Nagar Haveli and Daman and Diu', code: 'DH', gstCode: '26', zone: 'REST' },
  { name: 'Maharashtra', code: 'MH', gstCode: '27', zone: 'REST' },
  { name: 'Karnataka', code: 'KA', gstCode: '29', zone: 'SOUTH' },
  { name: 'Goa', code: 'GA', gstCode: '30', zone: 'REST' },
  { name: 'Lakshadweep', code: 'LD', gstCode: '31', zone: 'REMOTE' },
  { name: 'Kerala', code: 'KL', gstCode: '32', zone: 'KERALA' },
  { name: 'Tamil Nadu', code: 'TN', gstCode: '33', zone: 'SOUTH' },
  { name: 'Puducherry', code: 'PY', gstCode: '34', zone: 'SOUTH' },
  { name: 'Andaman and Nicobar Islands', code: 'AN', gstCode: '35', zone: 'REMOTE' },
  { name: 'Telangana', code: 'TS', gstCode: '36', zone: 'SOUTH' },
  { name: 'Andhra Pradesh', code: 'AP', gstCode: '37', zone: 'SOUTH' },
  { name: 'Ladakh', code: 'LA', gstCode: '38', zone: 'REMOTE' },
];

/** Older or alternative spellings found in the India Post directory (in comparison-key form) → canonical state name. */
export const STATE_ALIASES: Record<string, string> = {
  'ORISSA': 'Odisha',
  'CHATTISGARH': 'Chhattisgarh',
  'PONDICHERRY': 'Puducherry',
  'NEW DELHI': 'Delhi',
  'NCT OF DELHI': 'Delhi',
  'UTTARANCHAL': 'Uttarakhand',
  'DADRA AND NAGAR HAVELI': 'Dadra and Nagar Haveli and Daman and Diu',
  'DAMAN AND DIU': 'Dadra and Nagar Haveli and Daman and Diu',
  'ANDAMAN AND NICOBAR': 'Andaman and Nicobar Islands',
};
