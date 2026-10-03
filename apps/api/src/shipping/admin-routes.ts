// Admin Shipping Rates (api.md §4.8, product.md §7 "Shipping Rates", task 4.4) [shipping:write]: zones with weight
// slabs and extra ₹/kg, state → zone mapping, the SHIPPING setting (free-shipping threshold, heavy cap, packaging,
// default delivery policy, air-only areas), per-pincode delivery rules with CSV import, and a preview calculator.
import {
  PINCODE_CSV_HEADER, PINCODE_CSV_MAX_ROWS, pincodeField, pincodeImportBody, pincodeListQuery, pincodeRuleBody, shippingCharge, shippingPreviewBody,
  shippingSettingsBody, stateZonesBody, zoneBody, type Permission, type PincodeImportResult, type PincodeRuleView, type ShippingAdminView, type ShippingPreview,
} from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { markReadOnly, recordAudit } from '../admin/router.js';
import { noAppCache, type AppCache } from '../lib/app-cache.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { parseCsv } from '../seed/postal.js';
import { setting } from '../storefront/home.js';
import { destinationFor } from './destination.js';

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive() });
const pincodeParam = z.strictObject({ pincode: pincodeField });
const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

export function registerShippingRoutes(admin: AdminRoutes, prisma: PrismaClient, cache: AppCache = noAppCache): void {
  const r = admin.routes;
  const can = admin.can('shipping:write');
  const noStore = (res: Parameters<RequestHandler>[1]) => res.set('Cache-Control', 'private, no-store');

  const overview = async (): Promise<ShippingAdminView> => {
    const [zones, states, settings, used] = await Promise.all([
      prisma.shippingZone.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], include: { slabs: { orderBy: { maxWeightG: 'asc' } }, states: { orderBy: { name: 'asc' }, select: { id: true, name: true } } } }),
      prisma.state.findMany({ where: { isActive: true, country: { iso2: 'IN' } }, orderBy: { name: 'asc' }, select: { id: true, name: true, shippingZoneId: true } }),
      setting(prisma, 'SHIPPING'),
      prisma.order.groupBy({ by: ['shippingZoneId'], where: { shippingZoneId: { not: null } } }),
    ]);
    const inUse = new Set(used.map((u) => u.shippingZoneId));
    return {
      zones: zones.map((z) => ({ id: z.id, name: z.name, extraPerKg: z.extraPerKg, isActive: z.isActive, sortOrder: z.sortOrder, slabs: z.slabs.map((s) => ({ maxWeightG: s.maxWeightG, rate: s.rate })), states: z.states, usedByOrders: inUse.has(z.id) })),
      states: states.map((s) => ({ id: s.id, name: s.name, zoneId: s.shippingZoneId })),
      settings,
    };
  };
  r.get('/shipping', can, async (_req, res) => { noStore(res).json(await overview()); });

  // ── Zones ──
  r.post('/shipping/zones', can, validate({ body: zoneBody }), async (req, res) => {
    const b = req.body as z.output<typeof zoneBody>;
    await prisma.$transaction(async (tx) => {
      const last = await tx.shippingZone.aggregate({ _max: { sortOrder: true } });
      const z = await tx.shippingZone.create({ data: { name: b.name, extraPerKg: b.extraPerKg, isActive: b.isActive, sortOrder: (last._max.sortOrder ?? 0) + 1, slabs: { create: b.slabs } } });
      await recordAudit(tx, req, res, { action: 'shipping.zone.create', entity: 'shipping_zone', entityId: z.id, after: b });
    });
    noStore(res).status(201).json(await overview());
  });
  r.put('/shipping/zones/:id', can, validate({ params: idParam, body: zoneBody }), async (req, res) => {
    const id = (req.params as unknown as { id: number }).id;
    const b = req.body as z.output<typeof zoneBody>;
    await prisma.$transaction(async (tx) => {
      const before = await tx.shippingZone.findUnique({ where: { id }, include: { slabs: { orderBy: { maxWeightG: 'asc' } } } });
      if (!before) throw new AppError(404, 'NOT_FOUND', 'Zone not found');
      await tx.shippingRateSlab.deleteMany({ where: { zoneId: id } });
      await tx.shippingZone.update({ where: { id }, data: { name: b.name, extraPerKg: b.extraPerKg, isActive: b.isActive, slabs: { create: b.slabs } } });
      await recordAudit(tx, req, res, { action: 'shipping.zone.update', entity: 'shipping_zone', entityId: id, before: { name: before.name, extraPerKg: before.extraPerKg, isActive: before.isActive, slabs: before.slabs.map((s) => ({ maxWeightG: s.maxWeightG, rate: s.rate })) }, after: b });
    });
    noStore(res).json(await overview());
  });
  /** Only an unused zone with no states can be deleted; otherwise turn it off (orders keep their zone for audit). */
  r.delete('/shipping/zones/:id', can, validate({ params: idParam }), async (req, res) => {
    const id = (req.params as unknown as { id: number }).id;
    await prisma.$transaction(async (tx) => {
      const z = await tx.shippingZone.findUnique({ where: { id }, include: { _count: { select: { states: true, orders: true } } } });
      if (!z) throw new AppError(404, 'NOT_FOUND', 'Zone not found');
      if (z._count.states > 0) throw new AppError(409, 'ZONE_IN_USE', 'Move its states to another zone first.', { reason: 'STATES' });
      if (z._count.orders > 0) throw new AppError(409, 'ZONE_IN_USE', 'Orders were charged with this zone, so it is kept. Turn it off instead.', { reason: 'ORDERS' });
      await tx.shippingZone.delete({ where: { id } });
      await recordAudit(tx, req, res, { action: 'shipping.zone.delete', entity: 'shipping_zone', entityId: id, before: { name: z.name } });
    });
    noStore(res).json(await overview());
  });

  r.put('/shipping/state-zones', can, validate({ body: stateZonesBody }), async (req, res) => {
    const { assignments } = req.body as z.output<typeof stateZonesBody>;
    const zoneIds = [...new Set(assignments.map((a) => a.zoneId).filter((x): x is number => x !== null))];
    if ((await prisma.shippingZone.count({ where: { id: { in: zoneIds } } })) !== zoneIds.length) throw new AppError(422, 'NOT_FOUND', 'A chosen zone no longer exists. Reload and try again.');
    if ((await prisma.state.count({ where: { id: { in: assignments.map((a) => a.stateId) } } })) !== assignments.length) throw new AppError(422, 'NOT_FOUND', 'A state no longer exists. Reload and try again.');
    await prisma.$transaction(async (tx) => {
      const before = await tx.state.findMany({ where: { id: { in: assignments.map((a) => a.stateId) } }, select: { id: true, shippingZoneId: true } });
      const changed = assignments.filter((a) => before.find((s) => s.id === a.stateId)!.shippingZoneId !== a.zoneId);
      for (const a of changed) await tx.state.update({ where: { id: a.stateId }, data: { shippingZoneId: a.zoneId } });
      await recordAudit(tx, req, res, { action: 'shipping.states.update', entity: 'state', after: { changed } });
    });
    noStore(res).json(await overview());
  });

  r.put('/shipping/settings', can, validate({ body: shippingSettingsBody }), async (req, res) => {
    const value = req.body as z.output<typeof shippingSettingsBody>;
    await prisma.$transaction(async (tx) => {
      const before = await tx.setting.findUnique({ where: { key: 'SHIPPING' } });
      await tx.setting.upsert({ where: { key: 'SHIPPING' }, create: { key: 'SHIPPING', value, isPublic: true, updatedBy: req.auth!.userId }, update: { value, updatedBy: req.auth!.userId } });
      await recordAudit(tx, req, res, { action: 'settings.shipping.update', entity: 'setting', entityId: 'SHIPPING', before: before?.value ?? null, after: value });
    });
    await cache.invalidate('publicSettings');   // the storefront shows the free-shipping threshold and delivery days
    noStore(res).json(await overview());
  });

  // ── Pincode rules ──
  const ruleView = async (rows: { pincode: string; isServiceable: boolean; codAvailable: boolean; eddMinDays: number | null; eddMaxDays: number | null; note: string | null; source: string; updatedAt: Date }[]): Promise<PincodeRuleView[]> => {
    const offices = await prisma.postalCode.findMany({ where: { pincode: { in: rows.map((r) => r.pincode) } }, include: { state: true }, orderBy: { officeName: 'asc' } });
    return rows.map((x) => {
      const o = offices.find((p) => p.pincode === x.pincode);
      return { pincode: x.pincode, place: o ? { district: o.district, state: o.state.name } : null, isServiceable: x.isServiceable, codAvailable: x.codAvailable, eddMinDays: x.eddMinDays, eddMaxDays: x.eddMaxDays, note: x.note, source: x.source, updatedAt: x.updatedAt.toISOString() };
    });
  };
  r.get('/shipping/pincodes', can, validate({ query: pincodeListQuery }), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof pincodeListQuery>;
    const where: Prisma.PincodeServiceabilityWhereInput = {
      ...(q.q ? { pincode: { startsWith: q.q } } : {}),
      ...(q.filter === 'blocked' ? { isServiceable: false } : q.filter === 'no_cod' ? { isServiceable: true, codAvailable: false } : q.filter === 'custom_days' ? { eddMinDays: { not: null } } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.pincodeServiceability.count({ where }),
      prisma.pincodeServiceability.findMany({ where, orderBy: { pincode: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    noStore(res).json({ data: await ruleView(rows), meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } });
  });
  r.put('/shipping/pincodes/:pincode', can, validate({ params: pincodeParam, body: pincodeRuleBody }), async (req, res) => {
    const pincode = (req.params as unknown as { pincode: string }).pincode;
    const b = req.body as z.output<typeof pincodeRuleBody>;
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.pincodeServiceability.findUnique({ where: { pincode } });
      const data = { ...b, source: 'MANUAL', updatedBy: req.auth!.userId };
      const saved = await tx.pincodeServiceability.upsert({ where: { pincode }, create: { pincode, ...data }, update: data });
      await recordAudit(tx, req, res, { action: before ? 'shipping.pincode.update' : 'shipping.pincode.create', entity: 'pincode', entityId: pincode, before, after: b });
      return saved;
    });
    noStore(res).json((await ruleView([row]))[0]);
  });
  /** Removes the pincode's own rule: the default policy applies again. */
  r.delete('/shipping/pincodes/:pincode', can, validate({ params: pincodeParam }), async (req, res) => {
    const pincode = (req.params as unknown as { pincode: string }).pincode;
    await prisma.$transaction(async (tx) => {
      const before = await tx.pincodeServiceability.findUnique({ where: { pincode } });
      if (!before) throw new AppError(404, 'NOT_FOUND', 'This pincode has no rule of its own');
      await tx.pincodeServiceability.delete({ where: { pincode } });
      await recordAudit(tx, req, res, { action: 'shipping.pincode.delete', entity: 'pincode', entityId: pincode, before });
    });
    noStore(res).json({ ok: true });
  });

  /** CSV: pincode,deliverable,cod,edd_min_days,edd_max_days,note. Every row is checked; all are saved or none. */
  r.post('/shipping/pincodes/import', can, validate({ body: pincodeImportBody }), async (req, res) => {
    const { csv, dryRun } = req.body as z.output<typeof pincodeImportBody>;
    const result = await importPincodes(prisma, csv, dryRun, req.auth!.userId, (db, counts) => recordAudit(db, req, res, { action: 'shipping.pincode.import', entity: 'pincode', after: counts }));
    noStore(res).json(result);   // `saved: false` with the line errors when the file has problems
  });

  r.post('/shipping/preview', can, validate({ body: shippingPreviewBody }), async (req, res) => {
    const b = req.body as z.output<typeof shippingPreviewBody>;
    const d = await destinationFor(prisma, b.pincode);
    const base = { pincode: b.pincode, place: d.place ? { district: d.place.district, state: d.place.state } : null, zone: d.zone ? { id: d.zone.id, name: d.zone.name } : null, surfaceAvailable: d.serviceability.surfaceAvailable, serviceability: { serviceable: d.serviceability.serviceable, codAvailable: d.serviceability.codAvailable, fromRule: d.fromRule } };
    let quote: ShippingPreview['quote'];
    if (!d.place && !d.fromRule) quote = { ok: false, error: 'UNKNOWN_PINCODE' };
    else if (!d.zone) quote = { ok: false, error: d.serviceability.serviceable ? 'NO_ZONE' : 'PINCODE_NOT_SERVICEABLE' };
    else {
      const q = shippingCharge({ lines: [{ quantity: b.quantity, weightG: b.weightG, dimsCm: b.dimsCm, shippingClass: b.shippingClass }], zone: d.zone, serviceability: d.serviceability, subtotal: b.subtotal, couponDiscount: b.couponDiscount, freeShippingCoupon: b.freeShippingCoupon, settings: d.settings });
      quote = q.ok ? { ok: true, actualWeightG: q.actualWeightG, chargeableWeightG: q.chargeableWeightG, rate: q.rate, shipping: q.shipping, freeShippingApplied: q.freeShippingApplied, heavySurcharge: q.heavySurcharge, remainingForFree: q.remainingForFree } : q;
    }
    markReadOnly(res);   // a calculation: nothing changes
    noStore(res).json({ ...base, quote } satisfies ShippingPreview);
  });
}

type Rule = z.output<typeof pincodeRuleBody> & { pincode: string };

/** Parses and checks the whole file, then (unless a dry run, and only when every row is valid) saves it in one transaction. */
export async function importPincodes(prisma: PrismaClient, csv: string, dryRun: boolean, actorId: number, audit: (db: Prisma.TransactionClient, counts: object) => Promise<void>): Promise<PincodeImportResult> {
  const errors: PincodeImportResult['errors'] = [];
  const add = (line: number, message: string) => { if (errors.length < 100) errors.push({ line, message }); };
  const table = parseCsv(csv.replace(/^\uFEFF/, '')).filter((row) => row.some((c) => c.trim() !== ''));
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const missing = PINCODE_CSV_HEADER.slice(0, 3).filter((h) => !header.includes(h));
  if (missing.length) return { rows: 0, created: 0, updated: 0, unchanged: 0, errors: [{ line: 1, message: `The first row must name the columns: ${PINCODE_CSV_HEADER.join(', ')} (missing ${missing.join(', ')})` }], saved: false };
  const col = (row: string[], name: string) => { const i = header.indexOf(name); return i < 0 ? '' : (row[i] ?? '').trim(); };
  const rows = table.slice(1);
  if (rows.length > PINCODE_CSV_MAX_ROWS) return { rows: rows.length, created: 0, updated: 0, unchanged: 0, errors: [{ line: 1, message: `At most ${PINCODE_CSV_MAX_ROWS.toLocaleString('en-IN')} rows per file` }], saved: false };
  const rules: Rule[] = [];
  const seen = new Map<string, number>();
  rows.forEach((row, i) => {
    const line = i + 2;
    const pincode = col(row, 'pincode');
    if (!pincodeField.safeParse(pincode).success) { add(line, `“${pincode}” is not a 6-digit pincode`); return; }
    if (seen.has(pincode)) { add(line, `${pincode} is already on line ${seen.get(pincode)}`); return; }
    seen.set(pincode, line);
    const flag = (name: string) => { const v = col(row, name).toLowerCase(); return YES.has(v) ? true : NO.has(v) ? false : null; };
    const isServiceable = flag('deliverable'), codAvailable = flag('cod');
    if (isServiceable === null) { add(line, `deliverable must be yes or no`); return; }
    if (codAvailable === null) { add(line, `cod must be yes or no`); return; }
    const days = (name: string) => { const v = col(row, name); return v === '' ? null : /^\d+$/.test(v) ? Number(v) : Number.NaN; };
    const parsed = pincodeRuleBody.safeParse({ isServiceable, codAvailable, eddMinDays: days('edd_min_days'), eddMaxDays: days('edd_max_days'), note: col(row, 'note') });
    if (!parsed.success) { add(line, parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; ')); return; }
    rules.push({ pincode, ...parsed.data });
  });
  const existing = new Map((await prisma.pincodeServiceability.findMany({ where: { pincode: { in: rules.map((x) => x.pincode) } } })).map((x) => [x.pincode, x]));
  const same = (a: Rule) => { const e = existing.get(a.pincode); return !!e && e.isServiceable === a.isServiceable && e.codAvailable === a.codAvailable && e.eddMinDays === a.eddMinDays && e.eddMaxDays === a.eddMaxDays && (e.note ?? null) === a.note; };
  const counts = { rows: rows.length, created: rules.filter((x) => !existing.has(x.pincode)).length, updated: rules.filter((x) => existing.has(x.pincode) && !same(x)).length, unchanged: rules.filter(same).length };
  if (errors.length || dryRun) return { ...counts, errors, saved: false };
  const changed = rules.filter((x) => !same(x));
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < changed.length; i += 1000) {
      const b = changed.slice(i, i + 1000);
      await tx.$executeRaw`
        INSERT INTO pincode_serviceability (pincode, is_serviceable, cod_available, edd_min_days, edd_max_days, note, source, updated_by, updated_at)
        SELECT u.*, 'CSV', ${actorId}::int, now()
          FROM unnest(${b.map((x) => x.pincode)}::text[], ${b.map((x) => x.isServiceable)}::bool[], ${b.map((x) => x.codAvailable)}::bool[],
                      ${b.map((x) => x.eddMinDays)}::int[], ${b.map((x) => x.eddMaxDays)}::int[], ${b.map((x) => x.note)}::text[]) AS u
        ON CONFLICT (pincode) DO UPDATE SET is_serviceable = EXCLUDED.is_serviceable, cod_available = EXCLUDED.cod_available, edd_min_days = EXCLUDED.edd_min_days,
          edd_max_days = EXCLUDED.edd_max_days, note = EXCLUDED.note, source = 'CSV', updated_by = EXCLUDED.updated_by, updated_at = now()`;
    }
    await audit(tx, counts);
  }, { timeout: 60_000 });
  return { ...counts, errors, saved: true };
}
