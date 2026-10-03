// Pincode check for the product page (api.md §3.2, product.md §5.3, database.md §3.2). Uncached. A pincode must be in
// the postal directory (otherwise it is probably mistyped); delivery rules come from an explicit pincode_serviceability
// row, else the default policy in SHIPPING (decision D-6). Being in the directory does not make a pincode deliverable.
import type { PincodeCheck } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import { setting } from './home.js';

export async function checkPincode(prisma: PrismaClient, pincode: string): Promise<PincodeCheck> {
  const [office, rule, ship] = await Promise.all([
    prisma.postalCode.findFirst({ where: { pincode }, include: { state: true }, orderBy: { officeName: 'asc' } }),
    prisma.pincodeServiceability.findUnique({ where: { pincode } }),
    setting(prisma, 'SHIPPING'),
  ]);
  const place = office ? { district: office.district, state: office.state.name } : null;
  if (!office && !rule) return { pincode, place: null, serviceable: false, codAvailable: false, surfaceOnly: false, estimatedDays: null, reason: 'UNKNOWN_PINCODE' };
  const serviceable = rule ? rule.isServiceable : ship.defaultServiceable;
  if (!serviceable) return { pincode, place, serviceable: false, codAvailable: false, surfaceOnly: false, estimatedDays: null, reason: 'NOT_SERVICEABLE' };
  return {
    pincode, place, serviceable: true,
    codAvailable: rule ? rule.codAvailable : ship.defaultCod,
    surfaceOnly: rule?.surfaceOnly ?? false,
    estimatedDays: rule?.eddMinDays != null && rule.eddMaxDays != null ? { min: rule.eddMinDays, max: rule.eddMaxDays } : ship.estimatedDays,
    reason: null,
  };
}
