// E2E helper: prints the link in the latest auth email to <email> (the outbox row the email worker would deliver), so a
// browser test can follow an invite or reset link without a mailbox.
//   E2E_DATABASE_URL=postgresql://artq:artq@localhost:55432/artq_e2e tsx scripts/e2e-last-link.ts someone@artq.in [template]
// Refuses any database whose name is not artq_e2e.
import { PrismaClient } from '@prisma/client';

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error('E2E_DATABASE_URL is required');
if (new URL(url).pathname !== '/artq_e2e') throw new Error('refusing to read: only /artq_e2e is allowed');
const [email, template = 'staff_invite'] = process.argv.slice(2);
if (!email) throw new Error('usage: e2e-last-link.ts <email> [template]');

const prisma = new PrismaClient({ datasourceUrl: url });
try {
  const [row] = await prisma.$queryRaw<{ link: string | null }[]>`
    SELECT payload->'data'->>'link' AS link FROM outbox_events
     WHERE event_type = 'email.auth' AND payload->>'to' = ${email.toLowerCase()} AND payload->>'template' = ${template}
     ORDER BY id DESC LIMIT 1`;
  if (!row?.link) throw new Error(`no ${template} email for ${email}`);
  process.stdout.write(row.link);
} finally {
  await prisma.$disconnect();
}
