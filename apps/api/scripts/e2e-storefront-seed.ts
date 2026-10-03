// Storefront e2e data (task 3.1+): types, categories and public settings the pages are built from. Runs after
// e2e-setup.ts and before `next build`, because public pages are prerendered (ISR) from the API at build time.
// Refuses any database other than artq_e2e.
import { DEFAULT_SETTINGS } from '@artq/shared';
import { PrismaClient } from '@prisma/client';

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error('E2E_DATABASE_URL is required');
if (new URL(url).pathname !== '/artq_e2e') throw new Error(`refusing to seed ${new URL(url).pathname}: only /artq_e2e`);

export const STOREFRONT_FIXTURE = {
  types: [
    { name: 'Resins', slug: 'resins', categories: ['Art Resin', 'Casting Resin'] },
    { name: 'Wooden Frames', slug: 'wooden-frames', categories: ['Teak Frames'] },
    { name: 'Pigments', slug: 'pigments', categories: ['Mica Powder', 'Alcohol Inks'] },
  ],
  hiddenType: 'Retired Range',
  announcement: ['Shipping all over India', 'Free shipping on orders above ₹1000', 'E2E festival offer'],
  whatsapp: '+91 98470 12345',
  instagram: 'https://instagram.com/artq',
} as const;

const prisma = new PrismaClient({ datasourceUrl: url });
let sort = 0;
for (const t of STOREFRONT_FIXTURE.types) {
  const type = await prisma.productType.create({ data: { name: t.name, slug: t.slug, sortOrder: sort++ } });
  let c = 0;
  for (const name of t.categories) await prisma.category.create({ data: { typeId: type.id, name, slug: name.toLowerCase().replace(/\W+/g, '-'), sortOrder: c++ } });
}
await prisma.productType.create({ data: { name: STOREFRONT_FIXTURE.hiddenType, slug: 'retired-range', isActive: false } });
await prisma.setting.update({ where: { key: 'ANNOUNCEMENT_BAR' }, data: { value: { enabled: true, messages: [...STOREFRONT_FIXTURE.announcement] } } });
await prisma.setting.update({ where: { key: 'STORE_INFO' }, data: { value: { ...DEFAULT_SETTINGS.STORE_INFO, whatsapp: STOREFRONT_FIXTURE.whatsapp } } });
await prisma.setting.update({ where: { key: 'SOCIAL' }, data: { value: { ...DEFAULT_SETTINGS.SOCIAL, instagram: STOREFRONT_FIXTURE.instagram } } });
await prisma.$disconnect();
console.log('storefront e2e data ready');
