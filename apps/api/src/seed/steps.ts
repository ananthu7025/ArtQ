// Idempotent seed steps (database.md §10, task 1.3). Every step runs in one transaction holding a seed advisory lock,
// so concurrent runs serialise. Re-running never overwrites values an admin may have edited (rates, zone mapping,
// settings); it only creates what is missing and corrects fixed reference facts (state GST codes).
import { DEFAULT_SETTINGS, SETTING_KEYS, PUBLIC_SETTING_KEYS, settingSchemas } from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { hashPassword, PASSWORD_MAX, STAFF_PASSWORD_MIN } from '../lib/password.js';
import { INDIA, STATES, ZONES, type ZoneKey } from './reference-data.js';

export type StepResult = { created: number; updated: number; unchanged: number; notes: string[] };
const result = (): StepResult => ({ created: 0, updated: 0, unchanged: 0, notes: [] });

export class SeedError extends Error {
  constructor(message: string) { super(message); this.name = 'SeedError'; }
}

export function withSeedLock<T>(prisma: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('artq_seed'))`;
    return fn(tx);
  }, { maxWait: 60_000, timeout: 300_000 });
}

/** Zones with their slabs; an existing zone (matched by name) is left exactly as the admin configured it. */
export function seedShipping(prisma: PrismaClient): Promise<StepResult> {
  return withSeedLock(prisma, async (tx) => {
    const r = result();
    for (const z of ZONES) {
      const existing = await tx.shippingZone.findFirst({ where: { name: z.name } });
      if (existing) { r.unchanged++; continue; }
      await tx.shippingZone.create({
        data: { name: z.name, extraPerKg: z.extraPerKg, sortOrder: z.sortOrder, slabs: { create: z.slabs } },
      });
      r.created++;
    }
    return r;
  });
}

/** India + 36 states/UTs. Creates missing states; corrects code/GST code; sets a zone only where none is mapped. */
export function seedGeo(prisma: PrismaClient): Promise<StepResult> {
  return withSeedLock(prisma, async (tx) => {
    const r = result();
    const zoneIds = new Map<ZoneKey, number>();
    for (const z of ZONES) {
      const row = await tx.shippingZone.findFirst({ where: { name: z.name } });
      if (!row) throw new SeedError(`shipping zone "${z.name}" is missing: run the shipping step first`);
      zoneIds.set(z.key, row.id);
    }
    const country = await tx.country.upsert({ where: { iso2: INDIA.iso2 }, create: INDIA, update: {} });
    for (const s of STATES) {
      const existing = await tx.state.findUnique({ where: { countryId_name: { countryId: country.id, name: s.name } } });
      if (!existing) {
        await tx.state.create({ data: { countryId: country.id, name: s.name, code: s.code, gstCode: s.gstCode, shippingZoneId: zoneIds.get(s.zone)! } });
        r.created++;
        continue;
      }
      const patch: Prisma.StateUpdateInput = {};
      if (existing.code !== s.code) patch.code = s.code;
      if (existing.gstCode !== s.gstCode) patch.gstCode = s.gstCode;
      if (existing.shippingZoneId === null) patch.shippingZone = { connect: { id: zoneIds.get(s.zone)! } };
      if (Object.keys(patch).length) {
        await tx.state.update({ where: { id: existing.id }, data: patch });
        r.updated++;
      } else {
        r.unchanged++;
      }
    }
    return r;
  });
}

/** Every key of database.md §3.13 with its default; existing values are kept, invalid ones reported. */
export function seedSettings(prisma: PrismaClient): Promise<StepResult> {
  return withSeedLock(prisma, async (tx) => {
    const r = result();
    for (const key of SETTING_KEYS) {
      const existing = await tx.setting.findUnique({ where: { key } });
      if (!existing) {
        await tx.setting.create({ data: { key, value: DEFAULT_SETTINGS[key] as Prisma.InputJsonValue, isPublic: PUBLIC_SETTING_KEYS.includes(key) } });
        r.created++;
        continue;
      }
      r.unchanged++;
      if (!settingSchemas[key].safeParse(existing.value).success) r.notes.push(`setting ${key} has an invalid stored value (kept; fix it in the admin)`);
    }
    return r;
  });
}

export const adminSeedInput = z.strictObject({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  password: z.string().min(STAFF_PASSWORD_MIN).max(PASSWORD_MAX),
  name: z.string().trim().min(1).max(120).optional(),
});
export type AdminSeedInput = z.input<typeof adminSeedInput>;

/**
 * First SUPER_ADMIN. No MFA factor is created, so the first login must enrol MFA (task 1.6).
 * Skips when a live SUPER_ADMIN already exists; refuses to elevate an existing non-admin account.
 */
export async function seedAdmin(prisma: PrismaClient, input: AdminSeedInput): Promise<StepResult> {
  const parsed = adminSeedInput.safeParse(input);
  if (!parsed.success) throw new SeedError(`invalid admin seed input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const { email, password, name } = parsed.data;
  const passwordHash = await hashPassword(password);          // outside the transaction: argon2 is deliberately slow
  return withSeedLock(prisma, async (tx) => {
    const r = result();
    const superAdmin = await tx.user.findFirst({ where: { role: 'SUPER_ADMIN', deletedAt: null } });
    if (superAdmin) {
      r.unchanged++;
      r.notes.push(superAdmin.email === email ? 'super admin already exists' : 'a super admin already exists; seed admin skipped');
      return r;
    }
    const sameEmail = await tx.user.findFirst({ where: { email, deletedAt: null } });
    if (sameEmail) throw new SeedError(`${email} already belongs to a ${sameEmail.role} account; refusing to elevate it`);
    const user = await tx.user.create({
      data: { email, name: name ?? null, role: 'SUPER_ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash },
    });
    await tx.auditLog.create({ data: { actorId: null, action: 'user.seed_super_admin', entity: 'user', entityId: String(user.id), after: { email, role: 'SUPER_ADMIN', mfaEnrolled: false } } });
    r.created++;
    r.notes.push('super admin created; MFA enrolment is required at first login');
    return r;
  });
}
