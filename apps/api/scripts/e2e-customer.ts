// E2E helper (task 5.9): one customer account in the e2e database (a known name, a unique email). Prints {"id", "email"}.
//   E2E_DATABASE_URL=postgresql://artq:artq@localhost:55432/artq_e2e tsx scripts/e2e-customer.ts
// Refuses any database other than artq_e2e (the same guard as e2e-setup.ts).
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error('E2E_DATABASE_URL is required');
if (new URL(url).pathname !== '/artq_e2e') throw new Error('refusing: only /artq_e2e may be used');
const prisma = new PrismaClient({ datasourceUrl: url });
try {
  const email = `e2e-customer-${randomBytes(4).toString('hex')}@example.com`;
  const u = await prisma.user.create({ data: { email, name: 'Meera Customer', phone: '+919847099999', role: 'CUSTOMER', status: 'ACTIVE', emailVerifiedAt: new Date() } });
  console.log(JSON.stringify({ id: u.id, email }));
} finally {
  await prisma.$disconnect();
}
