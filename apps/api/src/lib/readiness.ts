import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { ReadinessChecks } from '../routes/health.js';

/** Real dependency checks used by /health/ready (database and Redis). */
export function makeReadinessChecks(prisma: Pick<PrismaClient, '$queryRaw'>, redis: Redis): ReadinessChecks {
  return {
    database: async () => { await prisma.$queryRaw`SELECT 1`; },
    redis: async () => {
      if (redis.status === 'wait') await redis.connect();
      const pong = await redis.ping();
      if (pong !== 'PONG') throw new Error(`unexpected PING reply: ${pong}`);
    },
  };
}
