// Settings (task 6.5; api.md §4.10 "Settings") [settings:write, i.e. Super Admin; saving also needs a recent password re-check].
//   GET /admin/settings                → AdminSettingsView (store info, payment, order, tax, notifications; states; last change)
//   PUT /admin/settings/{STORE_INFO|PAYMENT|ORDER|TAX|NOTIFY}
// A body holds only the fields the page edits; it is merged into the stored value and the result must pass the stored
// schema (settingSchemas), so nothing else in the setting changes. Audited with before/after; the public settings
// cache is dropped. The CMS keys (task 6.1) and SHIPPING (task 4.4) are saved by their own pages.
import {
  ADMIN_SETTING_BODIES, ADMIN_SETTING_KEYS, DEFAULT_SETTINGS, parseSetting, settingSchemas, PUBLIC_SETTING_KEYS,
  type AdminSettingKey, type AdminSettingsView, type Permission,
} from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request, RequestHandler, Response, Router } from 'express';
import { recordAudit } from '../admin/router.js';
import type { AppCache } from '../lib/app-cache.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';

type AdminRoutes = { routes: Router; can: (p: Permission, o?: { stepUp?: boolean }) => RequestHandler };
const fieldError = (path: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path, message }]);

export function registerSettingsRoutes(admin: AdminRoutes, prisma: PrismaClient, cache: AppCache): void {
  const r = admin.routes;
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');

  const view = async (): Promise<AdminSettingsView> => {
    const [rows, states] = await Promise.all([
      prisma.setting.findMany({ where: { key: { in: [...ADMIN_SETTING_KEYS] } } }),
      prisma.state.findMany({ where: { isActive: true, gstCode: { not: null } }, orderBy: { name: 'asc' }, select: { gstCode: true, name: true } }),
    ]);
    const editors = new Map((await prisma.user.findMany({ where: { id: { in: rows.map((x) => x.updatedBy).filter((x): x is number => x !== null) } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name ?? u.email]));
    const value = <K extends AdminSettingKey>(k: K) => {
      const row = rows.find((x) => x.key === k);
      // A stored value that no longer fits its schema is shown as the default (the save then repairs it).
      try { return row ? parseSetting(k, row.value) : DEFAULT_SETTINGS[k]; } catch { return DEFAULT_SETTINGS[k]; }
    };
    const updated = Object.fromEntries(ADMIN_SETTING_KEYS.map((k) => {
      const row = rows.find((x) => x.key === k);
      return [k, row ? { at: row.updatedAt.toISOString(), by: row.updatedBy === null ? null : (editors.get(row.updatedBy) ?? null) } : null];
    })) as AdminSettingsView['updated'];
    return {
      STORE_INFO: value('STORE_INFO'), PAYMENT: value('PAYMENT'), ORDER: value('ORDER'), TAX: value('TAX'), NOTIFY: value('NOTIFY'),
      states: states.map((s) => ({ code: s.gstCode!, name: s.name })), updated,
    };
  };

  // Reading needs no re-check (settings:write is a step-up permission by default).
  r.get('/settings', admin.can('settings:write', { stepUp: false }), async (_req, res) => { noStore(res).json(await view()); });

  for (const key of ADMIN_SETTING_KEYS) {
    r.put(`/settings/${key}`, admin.can('settings:write', { stepUp: true }), validate({ body: ADMIN_SETTING_BODIES[key] }), async (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      if (key === 'STORE_INFO' && !(await prisma.state.findFirst({ where: { gstCode: body.stateCode as string, isActive: true }, select: { id: true } }))) throw fieldError('stateCode', 'Choose the state');
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`setting:${key}`}))`;   // two saves of one key: one after the other
        const row = await tx.setting.findUnique({ where: { key } });
        let current: Record<string, unknown>;
        try { current = row ? (parseSetting(key, row.value) as Record<string, unknown>) : { ...DEFAULT_SETTINGS[key] }; } catch { current = { ...DEFAULT_SETTINGS[key] }; }
        const next = settingSchemas[key].parse({ ...current, ...body }) as Prisma.InputJsonValue;
        await tx.setting.upsert({ where: { key }, update: { value: next, updatedBy: req.auth!.userId }, create: { key, value: next, isPublic: PUBLIC_SETTING_KEYS.includes(key), updatedBy: req.auth!.userId } });
        await recordAudit(tx, req, res, { action: 'setting.update', entity: 'setting', entityId: key, before: row?.value ?? null, after: next });
      });
      await cache.invalidate('publicSettings');
      noStore(res).json(await view());
    });
  }
}
