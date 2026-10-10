// GET /admin/dashboard?range=today|7d|30d [dashboard:read] (task 5.9; api.md §4.2).
import { dashboardQuery, type Permission } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import type { RequestHandler, Router } from 'express';
import type { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { DashboardService } from './service.js';

export function registerDashboardRoutes(admin: { routes: Router; can: (p: Permission) => RequestHandler }, prisma: PrismaClient, service = new DashboardService(prisma)): void {
  admin.routes.get('/dashboard', admin.can('dashboard:read'), validate({ query: dashboardQuery }), async (req, res) => {
    res.set('Cache-Control', 'private, no-store').json(await service.get((req.query as unknown as z.output<typeof dashboardQuery>).range));
  });
}
