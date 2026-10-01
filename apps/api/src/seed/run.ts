import type { PrismaClient } from '@prisma/client';
import { seedPostalCodes } from './postal.js';
import { seedAdmin, seedGeo, seedSettings, seedShipping, SeedError, type AdminSeedInput, type StepResult } from './steps.js';

export type SeedOptions = { postalFile?: string | null; admin?: AdminSeedInput | null };
export type SeedReport = Record<'shipping' | 'geo' | 'settings' | 'postalCodes' | 'admin', StepResult | 'skipped'>;

/** Runs every seed step in dependency order. Safe to repeat. */
export async function runSeed(prisma: PrismaClient, opts: SeedOptions = {}): Promise<SeedReport> {
  const shipping = await seedShipping(prisma);
  const geo = await seedGeo(prisma);
  const settings = await seedSettings(prisma);
  const postalCodes = opts.postalFile ? await seedPostalCodes(prisma, opts.postalFile) : 'skipped';
  const admin = opts.admin ? await seedAdmin(prisma, opts.admin) : 'skipped';
  return { shipping, geo, settings, postalCodes, admin };
}

/** Admin input from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_NAME (never from argv: it would leak into shell history). */
export function adminFromEnv(env: NodeJS.ProcessEnv): AdminSeedInput | null {
  const email = env.SEED_ADMIN_EMAIL?.trim();
  const password = env.SEED_ADMIN_PASSWORD;
  if (!email && !password) return null;
  if (!email || !password) throw new SeedError('set both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD, or neither');
  return env.SEED_ADMIN_NAME ? { email, password, name: env.SEED_ADMIN_NAME } : { email, password };
}

/** Parses `--postal-codes <file>`; unknown arguments are an error. */
export function parseArgs(argv: string[]): { postalFile: string | null } {
  let postalFile: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--postal-codes') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new SeedError('--postal-codes needs a file path');
      postalFile = v;
    } else {
      throw new SeedError(`unknown argument ${argv[i]} (usage: db:seed [--postal-codes <india-post.csv>])`);
    }
  }
  return { postalFile };
}

export function formatReport(report: SeedReport): string {
  return Object.entries(report).map(([step, r]) => r === 'skipped'
    ? `${step.padEnd(12)} skipped`
    : `${step.padEnd(12)} created ${r.created}, updated ${r.updated}, unchanged ${r.unchanged}${r.notes.map((n) => `\n${' '.repeat(13)}${n}`).join('')}`).join('\n');
}
