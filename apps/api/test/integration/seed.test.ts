// Task 1.3: seeds on a database built by the real migrations. ✅ Idempotent re-run.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_SETTINGS, shippingCharge } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '../../src/lib/password.js';
import { seedPostalCodes } from '../../src/seed/postal.js';
import { runSeed } from '../../src/seed/run.js';
import { seedAdmin, seedGeo, seedSettings, seedShipping, SeedError } from '../../src/seed/steps.js';
import { API_ROOT, createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { startPostgres, type Service } from '../helpers/services.js';

const SAMPLE = join(API_ROOT, 'prisma', 'seed-data', 'postal-codes.sample.csv');
const ADMIN = { email: 'Owner@ArtQ.in', password: 'a-long-enough-passphrase', name: 'Owner' };
const run = promisify(execFile);

let pg: Service;
const dbs: TestDb[] = [];
const tmp: string[] = [];
beforeAll(async () => { pg = await startPostgres(); }, 120_000);
afterAll(async () => {
  for (const d of dbs) await d.drop();
  for (const t of tmp) rmSync(t, { recursive: true, force: true });
  await pg?.stop();
});
async function fresh(): Promise<PrismaClient> {
  const d = await createMigratedDatabase(pg.url);
  dbs.push(d);
  return d.prisma;
}
const count = (p: PrismaClient, table: string) => p.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`).then((r) => r[0]!.n);

describe('full seed', () => {
  it('first run creates everything; the second run changes nothing', async () => {
    const p = await fresh();
    const first = await runSeed(p, { postalFile: SAMPLE, admin: ADMIN });
    expect(first.shipping).toMatchObject({ created: 4, updated: 0, unchanged: 0 });
    expect(first.geo).toMatchObject({ created: 36, updated: 0, unchanged: 0 });
    expect(first.settings).toMatchObject({ created: 11, updated: 0, unchanged: 0, notes: [] });
    expect(first.postalCodes).toMatchObject({ created: 16, updated: 0, unchanged: 0, skipped: 0 });
    expect(first.admin).toMatchObject({ created: 1 });
    const snapshot = async () => ({
      states: await count(p, 'states'), countries: await count(p, 'countries'), zones: await count(p, 'shipping_zones'),
      slabs: await count(p, 'shipping_rate_slabs'), settings: await count(p, 'settings'), postal: await count(p, 'postal_codes'),
      users: await count(p, 'users'), audit: await count(p, 'audit_logs'),
      hash: (await p.user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } })).passwordHash,
    });
    const before = await snapshot();
    expect(before).toMatchObject({ states: 36, countries: 1, zones: 4, slabs: 16, settings: 11, postal: 16, users: 1, audit: 1 });

    const second = await runSeed(p, { postalFile: SAMPLE, admin: ADMIN });
    expect(second.shipping).toMatchObject({ created: 0, updated: 0, unchanged: 4 });
    expect(second.geo).toMatchObject({ created: 0, updated: 0, unchanged: 36 });
    expect(second.settings).toMatchObject({ created: 0, updated: 0, unchanged: 11 });
    expect(second.postalCodes).toMatchObject({ created: 0, updated: 0, unchanged: 16 });
    expect(second.admin).toMatchObject({ created: 0, unchanged: 1, notes: ['super admin already exists'] });
    expect(await snapshot()).toEqual(before);
  });

  it('seeded zones, slabs and settings reproduce the architecture.md §6.5 worked example', async () => {
    const p = await fresh();
    await runSeed(p);
    const kerala = await p.state.findFirstOrThrow({ where: { gstCode: '32' }, include: { shippingZone: { include: { slabs: true } } } });
    const zone = kerala.shippingZone!;
    expect(zone.name).toBe('Kerala');
    const settings = (await p.setting.findUniqueOrThrow({ where: { key: 'SHIPPING' } })).value as typeof DEFAULT_SETTINGS.SHIPPING;
    const quote = (subtotal: number) => shippingCharge({
      lines: [{ quantity: 2, weightG: 6000, dimsCm: null, shippingClass: 'STANDARD' }],
      zone: { id: zone.id, extraPerKg: zone.extraPerKg, slabs: zone.slabs.map((s) => ({ maxWeightG: s.maxWeightG, rate: s.rate })) },
      serviceability: { serviceable: true, codAvailable: true, surfaceAvailable: true }, subtotal, couponDiscount: 0, freeShippingCoupon: false, settings,
    });
    expect(quote(1_090_000)).toMatchObject({ ok: true, shipping: 12_000 });
    expect(quote(90_000)).toMatchObject({ ok: true, shipping: 54_000 });
    const ka = await p.state.findFirstOrThrow({ where: { gstCode: '29' }, include: { shippingZone: true } });
    expect(ka.shippingZone!.name).toBe('Rest of South');
    const settingRows = await p.setting.findMany({ orderBy: { key: 'asc' } });
    expect(settingRows.filter((s) => s.isPublic).map((s) => s.key)).not.toContain('TAX');
    expect(settingRows.find((s) => s.key === 'PAYMENT')!.value).toEqual(DEFAULT_SETTINGS.PAYMENT);
  });

  it('three concurrent full runs leave exactly one copy of everything', async () => {
    const p = await fresh();
    await Promise.all([runSeed(p, { admin: ADMIN }), runSeed(p, { admin: ADMIN }), runSeed(p, { admin: { ...ADMIN, email: 'other@artq.in' } })]);
    expect([await count(p, 'states'), await count(p, 'shipping_zones'), await count(p, 'shipping_rate_slabs'), await count(p, 'settings'), await count(p, 'users')])
      .toEqual([36, 4, 16, 11, 1]);
  });
});

describe('re-running keeps admin edits', () => {
  it('edited rates, zone mapping and settings survive; fixed facts are corrected; missing rows are re-created', async () => {
    const p = await fresh();
    await runSeed(p);
    const kerala = await p.shippingZone.findFirstOrThrow({ where: { name: 'Kerala' } });
    await p.shippingRateSlab.updateMany({ where: { zoneId: kerala.id, maxWeightG: 500 }, data: { rate: 5500 } });
    const remote = await p.shippingZone.findFirstOrThrow({ where: { name: 'NE / J&K / islands' } });
    await p.state.updateMany({ where: { name: 'Goa' }, data: { shippingZoneId: remote.id } });            // admin remapped Goa
    await p.state.updateMany({ where: { name: 'Kerala' }, data: { gstCode: '99' } });                      // corrupted fact
    await p.state.updateMany({ where: { name: 'Bihar' }, data: { shippingZoneId: null } });                // unmapped
    await p.setting.update({ where: { key: 'SHIPPING' }, data: { value: { ...DEFAULT_SETTINGS.SHIPPING, freeThreshold: 150_000 } } });
    await p.setting.update({ where: { key: 'HERO' }, data: { value: { slideIntervalMs: 'fast' } } });     // invalid stored value
    await p.setting.delete({ where: { key: 'NOTIFY' } });

    const again = await runSeed(p);
    expect(again.geo).toMatchObject({ created: 0, updated: 2, unchanged: 34 });
    expect(again.settings).toMatchObject({ created: 1, unchanged: 10 });
    expect((again.settings as { notes: string[] }).notes).toEqual(['setting HERO has an invalid stored value (kept; fix it in the admin)']);
    expect((await p.shippingRateSlab.findFirstOrThrow({ where: { zoneId: kerala.id, maxWeightG: 500 } })).rate).toBe(5500);
    expect((await p.state.findFirstOrThrow({ where: { name: 'Goa' } })).shippingZoneId).toBe(remote.id);
    expect((await p.state.findFirstOrThrow({ where: { name: 'Kerala' } })).gstCode).toBe('32');
    expect((await p.state.findFirstOrThrow({ where: { name: 'Bihar' }, include: { shippingZone: true } })).shippingZone!.name).toBe('Rest of India');
    expect(((await p.setting.findUniqueOrThrow({ where: { key: 'SHIPPING' } })).value as { freeThreshold: number }).freeThreshold).toBe(150_000);
    expect((await p.setting.findUniqueOrThrow({ where: { key: 'NOTIFY' } })).value).toEqual(DEFAULT_SETTINGS.NOTIFY);
  });

  it('steps out of order fail clearly and roll back', async () => {
    const p = await fresh();
    await expect(seedGeo(p)).rejects.toThrow(/shipping zone "Kerala" is missing/);
    expect(await count(p, 'countries')).toBe(0);
    await expect(seedPostalCodes(p, SAMPLE)).rejects.toThrow(/no states/);
  });
});

describe('postal codes', () => {
  it('updates changed rows only, reports skipped rows, and fails on a missing file', async () => {
    const p = await fresh();
    await seedShipping(p); await seedGeo(p); await seedSettings(p);
    expect(await seedPostalCodes(p, SAMPLE)).toMatchObject({ created: 16 });
    const dir = mkdtempSync(join(tmpdir(), 'artq-postal-')); tmp.push(dir);
    const file = join(dir, 'pins.csv');
    writeFileSync(file, readFileSync(SAMPLE, 'utf8').replace('ERNAKULAM H.O,682011,H.O,Delivery,ERNAKULAM', 'ERNAKULAM H.O,682011,H.O,Delivery,KOCHI')
      + 'X,Y,Z,BAD,12345,S.O,Delivery,D,KERALA,NA,NA\nX,Y,Z,NOWHERE S.O,682999,S.O,Delivery,D,ATLANTIS,NA,NA\n');
    const r = await seedPostalCodes(p, file, 5);                  // small batches exercise batching
    expect(r).toMatchObject({ created: 0, updated: 1, unchanged: 15, skipped: 2 });
    expect(r.notes).toEqual(['line 18: invalid pincode "12345"', 'line 19: unknown state "ATLANTIS"']);
    const row = await p.postalCode.findFirstOrThrow({ where: { pincode: '682011' }, include: { state: true } });
    expect(row).toMatchObject({ officeName: 'Ernakulam H.O', district: 'Kochi', state: { name: 'Kerala' } });
    expect((await p.postalCode.findFirstOrThrow({ where: { pincode: '396230' }, include: { state: true } })).state.name).toBe('Dadra and Nagar Haveli and Daman and Diu');
    await expect(seedPostalCodes(p, join(dir, 'missing.csv'))).rejects.toThrow(/ENOENT/);
  });
});

describe('first super admin', () => {
  it('creates an ACTIVE, verified SUPER_ADMIN with an argon2id password, no MFA factor and an audit entry', async () => {
    const p = await fresh();
    const r = await seedAdmin(p, ADMIN);
    expect(r).toMatchObject({ created: 1, notes: ['super admin created; MFA enrolment is required at first login'] });
    const u = await p.user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' }, include: { mfaFactor: true } });
    expect(u).toMatchObject({ email: 'owner@artq.in', name: 'Owner', status: 'ACTIVE', mfaFactor: null });
    expect(u.emailVerifiedAt).not.toBeNull();
    expect(await verifyPassword(u.passwordHash!, ADMIN.password)).toBe(true);
    expect(await p.auditLog.findFirstOrThrow({ where: { entity: 'user', entityId: String(u.id) } })).toMatchObject({ action: 'user.seed_super_admin', actorId: null });
  });

  it('skips when a super admin exists (same or different email) and never changes the existing password', async () => {
    const p = await fresh();
    await seedAdmin(p, ADMIN);
    const hash = (await p.user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } })).passwordHash;
    expect(await seedAdmin(p, { ...ADMIN, password: 'a-different-passphrase' })).toMatchObject({ unchanged: 1, notes: ['super admin already exists'] });
    expect(await seedAdmin(p, { ...ADMIN, email: 'second@artq.in' })).toMatchObject({ unchanged: 1, notes: ['a super admin already exists; seed admin skipped'] });
    expect((await p.user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } })).passwordHash).toBe(hash);
    expect(await count(p, 'users')).toBe(1);
  });

  it('refuses to elevate an existing customer account', async () => {
    const p = await fresh();
    await p.user.create({ data: { email: 'owner@artq.in', role: 'CUSTOMER', status: 'ACTIVE' } });
    await expect(seedAdmin(p, ADMIN)).rejects.toThrow(/already belongs to a CUSTOMER account; refusing to elevate/);
    expect((await p.user.findFirstOrThrow({ where: { email: 'owner@artq.in' } })).role).toBe('CUSTOMER');
    expect(await count(p, 'audit_logs')).toBe(0);
  });

  it.each([
    ['short password', { ...ADMIN, password: 'short' }, /password/],
    ['over-long password', { ...ADMIN, password: 'x'.repeat(129) }, /password/],
    ['invalid email', { ...ADMIN, email: 'not-an-email' }, /email/],
    ['unknown field', { ...ADMIN, role: 'CUSTOMER' } as typeof ADMIN, /invalid admin seed input/],
  ])('rejects %s without creating anything', async (_d, input, re) => {
    const p = await fresh();
    const err = await seedAdmin(p, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeedError);
    expect((err as Error).message).toMatch(re);
    expect((err as Error).message).not.toContain(input.password);        // never echo the password
    expect(await count(p, 'users')).toBe(0);
  });

  it('two concurrent seeds with different emails create exactly one super admin', async () => {
    const p = await fresh();
    const r = await Promise.all([seedAdmin(p, ADMIN), seedAdmin(p, { ...ADMIN, email: 'b@artq.in' })]);
    expect(r.map((x) => x.created).sort()).toEqual([0, 1]);
    expect(await p.user.count({ where: { role: 'SUPER_ADMIN' } })).toBe(1);
  });
});

describe('CLI (pnpm db:seed)', () => {
  const tsx = join(API_ROOT, 'node_modules', '.bin', 'tsx');
  const cli = (url: string, args: string[], env: Record<string, string> = {}) =>
    run(tsx, ['src/seed/cli.ts', ...args], { cwd: API_ROOT, env: { ...process.env, DATABASE_URL: url, ...env } })
      .then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }));

  it('seeds end to end, then reports everything unchanged; bad input exits 1 with a clear message', async () => {
    const d = await createMigratedDatabase(pg.url); dbs.push(d);
    const env = { SEED_ADMIN_EMAIL: 'cli@artq.in', SEED_ADMIN_PASSWORD: 'cli-passphrase-123' };
    const first = await cli(d.url, ['--postal-codes', SAMPLE], env);
    expect(first.code).toBe(0);
    expect(first.out).toContain('geo          created 36, updated 0, unchanged 0');
    expect(first.out).toContain('postalCodes  created 16');
    expect(first.out).not.toContain(env.SEED_ADMIN_PASSWORD);
    const second = await cli(d.url, ['--postal-codes', SAMPLE], env);
    expect(second.code).toBe(0);
    expect(second.out).toContain('geo          created 0, updated 0, unchanged 36');
    expect(second.out).toContain('admin        created 0, updated 0, unchanged 1');

    expect(await cli(d.url, ['--bogus'])).toMatchObject({ code: 1, err: expect.stringContaining('seed failed: unknown argument --bogus') });
    expect(await cli(d.url, [], { SEED_ADMIN_EMAIL: 'x@artq.in' })).toMatchObject({ code: 1, err: expect.stringContaining('set both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD') });
    const down = await cli('postgresql://postgres:postgres@127.0.0.1:1/none', []);
    expect(down.code).toBe(1);
  }, 120_000);
});
