// pnpm --filter @artq/api db:seed [--postal-codes <file>]   (DATABASE_URL; optional SEED_ADMIN_EMAIL/PASSWORD/NAME)
import { PrismaClient } from '@prisma/client';
import { adminFromEnv, formatReport, parseArgs, runSeed } from './run.js';
import { SeedError } from './steps.js';

const prisma = new PrismaClient();
try {
  const { postalFile } = parseArgs(process.argv.slice(2));
  const report = await runSeed(prisma, { postalFile, admin: adminFromEnv(process.env) });
  process.stdout.write(formatReport(report) + '\n');
} catch (e) {
  console.error(e instanceof SeedError ? `seed failed: ${e.message}` : e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
