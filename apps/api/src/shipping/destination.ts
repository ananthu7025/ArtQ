// Where a pincode ships from the store's point of view (product.md §8.2, architecture.md §6.5, database.md §3.2): the
// postal place, its state's zone (with slabs), the delivery rule (an explicit pincode row, else the D-6 defaults) and
// whether surface transport reaches it (D-7, SHIPPING.airOnlyPincodePrefixes). Used by the admin preview (task 4.4)
// and by checkout; shippingCharge (packages/shared) does the arithmetic.
import { resolveServiceability, surfaceAvailable, type Serviceability, type SettingValue, type ShippingZone } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import { setting } from '../storefront/home.js';

export type Destination = {
  pincode: string;
  place: { district: string; state: string; stateId: number; gstStateCode: string | null } | null;
  /** The state's zone when it is active and has slabs; null = no rate for this pincode. */
  zone: (ShippingZone & { name: string }) | null;
  serviceability: Serviceability;
  /** True when the pincode has its own rule (rather than the default policy). */
  fromRule: boolean;
  settings: SettingValue<'SHIPPING'>;
};

export async function destinationFor(prisma: PrismaClient, pincode: string): Promise<Destination> {
  const [office, rule, settings] = await Promise.all([
    prisma.postalCode.findFirst({ where: { pincode }, include: { state: { include: { shippingZone: { include: { slabs: { orderBy: { maxWeightG: 'asc' } } } } } } }, orderBy: { officeName: 'asc' } }),
    prisma.pincodeServiceability.findUnique({ where: { pincode } }),
    setting(prisma, 'SHIPPING'),
  ]);
  const z = office?.state.shippingZone;
  return {
    pincode,
    place: office ? { district: office.district, state: office.state.name, stateId: office.state.id, gstStateCode: office.state.gstCode } : null,
    zone: z && z.isActive && z.slabs.length ? { id: z.id, name: z.name, extraPerKg: z.extraPerKg, slabs: z.slabs.map((s) => ({ maxWeightG: s.maxWeightG, rate: s.rate })) } : null,
    serviceability: resolveServiceability(rule, settings, surfaceAvailable(pincode, settings.airOnlyPincodePrefixes)),
    fromRule: rule !== null,
    settings,
  };
}
