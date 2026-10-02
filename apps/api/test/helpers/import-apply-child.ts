// Test helper: applies one import in its own process, pausing inside the second batch's transaction so the parent test
// can SIGKILL it mid-batch (task 2.7 "killing the worker mid-import and restarting completes without duplicates").
//   node --import tsx test/helpers/import-apply-child.ts <importId>     (DATABASE_URL = the test database)
import { PrismaClient } from '@prisma/client';
import { ImportService } from '../../src/imports/service.js';

const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const service = new ImportService({ prisma, readFile: async () => Buffer.alloc(0), enqueue: { validate: async () => {}, apply: async () => {} } });
await service.apply(Number(process.argv[2]), { beforeCommit: async (batch) => { if (batch === 2) { process.stdout.write('IN_BATCH_2\n'); await new Promise((r) => setTimeout(r, 60_000)); } } });
await prisma.$disconnect();
