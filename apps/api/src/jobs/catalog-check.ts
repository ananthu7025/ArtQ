// Nightly catalogue checks (database.md §6a, §7; architecture.md §11 alerts). Runs in the worker's maintenance queue.
// 1. published_not_ready: a related row changed after publication in a way the edit-guard cannot see (a cover image
//    failed processing, media deleted) → one PUBLISHED_NOT_READY payment exception per product and failure set.
// 2. product_aggregate_drift: should be empty (aggregates change in the same transaction); any drift is rebuilt here
//    and reported so it can be investigated.
import type { PrismaClient } from '@prisma/client';
import * as fn from '../db/functions.js';

export type CatalogCheckResult = { publishedNotReady: number; driftRepaired: number[] };

export async function runCatalogChecks(prisma: PrismaClient): Promise<CatalogCheckResult> {
  const notReady = await prisma.$queryRaw<{ id: number; failures: string[] }[]>`SELECT id, failures FROM published_not_ready ORDER BY id`;
  for (const p of notReady) {
    const failures = [...p.failures].sort();
    // Deduplicated per product + failure set: repeated nights add nothing until the problem changes.
    await fn.raiseException(prisma, { type: 'PUBLISHED_NOT_READY', dedupeKey: `PUBLISHED_NOT_READY:${p.id}:${failures.join(',')}`, details: { product_id: p.id, failures } });
  }
  const drift = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM product_aggregate_drift ORDER BY id`).map((r) => r.id);
  if (drift.length) await prisma.$transaction((tx) => fn.refreshProducts(tx, drift));
  return { publishedNotReady: notReady.length, driftRepaired: drift };
}
