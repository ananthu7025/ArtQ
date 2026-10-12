// E2E helper (task 5.5): the customer's side of a return for a delivered order in the e2e database, through the real
// database function (aq_request_return): both units of its first item, "arrived damaged", with one processed private
// photo (a media row in the order's return scope, as the upload + worker leave it). Prints {"returnId": n}.
//   E2E_DATABASE_URL=postgresql://artq:artq@localhost:55432/artq_e2e tsx scripts/e2e-return.ts <order id>
// Refuses any database other than artq_e2e (the same guard as e2e-setup.ts).
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import * as fn from '../src/db/functions.js';

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error('E2E_DATABASE_URL is required');
if (new URL(url).pathname !== '/artq_e2e') throw new Error('refusing: only /artq_e2e may be used');
const orderId = Number(process.argv[2]);
if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('usage: e2e-return.ts <order id>');

const prisma = new PrismaClient({ datasourceUrl: url });
try {
  const returnId = await prisma.$transaction(async (tx) => {
    const item = await tx.orderItem.findFirstOrThrow({ where: { orderId }, orderBy: { id: 'asc' } });
    const photo = await tx.media.create({ data: {
      key: `private/return-photo/e2e/${randomUUID()}.jpg`, visibility: 'PRIVATE', kind: 'IMAGE', declaredMime: 'image/jpeg', declaredSize: 10, ownerScope: `return:${orderId}`, status: 'READY',
    } });
    return fn.requestReturn(tx, { orderId, userId: null, reason: 'DAMAGED', description: 'One bottle arrived cracked and leaking', items: [{ orderItemId: item.id, quantity: item.quantity }], mediaIds: [photo.id], windowHours: 48 });
  });
  console.log(JSON.stringify({ returnId }));
} finally {
  await prisma.$disconnect();
}
