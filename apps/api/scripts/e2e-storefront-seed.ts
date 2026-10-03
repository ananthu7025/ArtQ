// Storefront e2e data (task 3.1+). Runs after e2e-setup.ts and `seed-demo.ts` (the client's catalogue through the real
// import, then the demo showcase published through the real gate), and before `next build`, because public pages are
// prerendered from the API at build time (ISR). Adds what the layout tests look for. Refuses any database but artq_e2e.
import { DEFAULT_SETTINGS } from '@artq/shared';
import { PrismaClient } from '@prisma/client';

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error('E2E_DATABASE_URL is required');
if (new URL(url).pathname !== '/artq_e2e') throw new Error(`refusing to seed ${new URL(url).pathname}: only /artq_e2e`);

export const STOREFRONT_FIXTURE = {
  hiddenType: 'Retired Range',
  announcement: ['Shipping all over India', 'Free shipping on orders above ₹1000', 'E2E festival offer'],
  whatsapp: '+91 98470 12345',
  instagram: 'https://instagram.com/artq',
} as const;

const prisma = new PrismaClient({ datasourceUrl: url });
await prisma.productType.create({ data: { name: STOREFRONT_FIXTURE.hiddenType, slug: 'retired-range', isActive: false } });
await prisma.setting.update({ where: { key: 'ANNOUNCEMENT_BAR' }, data: { value: { enabled: true, messages: [...STOREFRONT_FIXTURE.announcement] } } });
await prisma.setting.update({ where: { key: 'STORE_INFO' }, data: { value: { ...DEFAULT_SETTINGS.STORE_INFO, whatsapp: STOREFRONT_FIXTURE.whatsapp } } });
await prisma.setting.update({ where: { key: 'SOCIAL' }, data: { value: { ...DEFAULT_SETTINGS.SOCIAL, instagram: STOREFRONT_FIXTURE.instagram } } });
await prisma.$disconnect();
console.log('storefront e2e data ready');
