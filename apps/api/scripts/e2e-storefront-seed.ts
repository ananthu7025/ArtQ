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
// One real pincode for the product page's delivery check (the full India Post directory is loaded at deploy).
const kerala = await prisma.state.findFirstOrThrow({ where: { gstCode: '32' } });
await prisma.postalCode.upsert({ where: { pincode_officeName: { pincode: '682011', officeName: 'ERNAKULAM H.O' } }, update: {}, create: { pincode: '682011', officeName: 'ERNAKULAM H.O', district: 'ERNAKULAM', stateId: kerala.id } });
// Coupons for the cart tests (task 4.5): one that applies to any cart, one no cart reaches.
await prisma.coupon.createMany({ data: [
  { code: 'WELCOME10', title: 'Welcome offer', type: 'PERCENT', value: 10, maxDiscount: 20_000, usageLimitPerCustomer: null, isPublic: true },
  { code: 'BULK500', title: 'Bulk order', type: 'FLAT', value: 50_000, minOrderValue: 50_000_000, usageLimitPerCustomer: null, isPublic: true },
], skipDuplicates: true });
// SEO (task 6.4): an old shop address that moves, and an owner's search listing for the FAQ page.
await prisma.redirect.createMany({ data: [{ fromPath: '/collections/e2e-resins', toPath: '/shop' }], skipDuplicates: true });
await prisma.seoOverride.createMany({ data: [{ path: '/faqs', metaTitle: 'Resin art questions answered' }], skipDuplicates: true });
await prisma.$disconnect();
console.log('storefront e2e data ready');
