// Local demo data, so the admin and the storefront have something real to show:
//   pnpm --filter @artq/api db:seed:demo            (after db:seed; uses DATABASE_URL)
// 1. The client's workbook (ArtQ_Product_Import_All_Items.xlsx) through the real catalogue import, exactly as the admin's
//    Imports page does it (create missing types/categories): types, categories and draft products from the real data.
// 2. Types in the reference site's order (design-system.md §6.1).
// 3. Sample store contact (WhatsApp, Instagram) — only where the owner has not set a value.
// 4. A showcase for testing the storefront (scripts/demo-showcase.ts): about a dozen of those drafts finished and
//    published through the real gate with generated demo photos, plus range-circle images, techniques, sample reviews
//    and a hero image. Needs the local S3 storage (docker compose). Skip with --no-showcase.
// Safe to run again: the import is skipped once it has completed (use --reimport to run it again).
// Refuses production and any database that is not on this machine.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, parseSetting } from '@artq/shared';
import { PrismaClient } from '@prisma/client';
import { ImportService } from '../src/imports/service.js';
import { MediaService } from '../src/media/service.js';
import { S3ObjectStore } from '../src/media/storage.js';
import { seedShowcase } from './demo-showcase.js';
import { seedSettings } from '../src/seed/steps.js';

const FILE_NAME = 'ArtQ_Product_Import_All_Items.xlsx';
const REFERENCE_ORDER = ['Resins', 'Wooden Frames', 'Multiwood Frames', 'Hoops', 'Silica Gel', 'Pigments', 'Glitters', 'UV Resin'];
const DEMO_CONTACT = { whatsapp: '+91 98765 43210', instagram: 'https://www.instagram.com/artq' };

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
if (process.env.NODE_ENV === 'production') throw new Error('refusing to load demo data with NODE_ENV=production');
const host = new URL(url).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`refusing to load demo data into ${host}: local databases only`);

const prisma = new PrismaClient({ datasourceUrl: url });
try {
  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE', deletedAt: null }, orderBy: { id: 'asc' } });
  if (!admin) throw new Error('no active SUPER_ADMIN: run `pnpm --filter @artq/api db:seed` first');
  // The import needs every migration (0004 adds the initial-stock function); say so instead of failing 98 rows.
  const applied = new Set((await prisma.$queryRaw<{ name: string }[]>`SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL`).map((m) => m.name));
  const missing = readdirSync(join(import.meta.dirname, '..', 'prisma', 'migrations'), { withFileTypes: true }).filter((d) => d.isDirectory() && !applied.has(d.name)).map((d) => d.name);
  if (missing.length) throw new Error(`the database is missing migrations ${missing.join(', ')}: run \`pnpm --filter @artq/api migrate:deploy\` first`);
  await seedSettings(prisma);

  // 1. Catalogue import
  // Done = a finished import of this file that applied at least one row (a fully failed one does not count).
  const done = (await prisma.productImport.findMany({ where: { kind: 'CATALOG', fileName: FILE_NAME, status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS'] } }, orderBy: { id: 'desc' } }))
    .find((i) => i.failedCount < i.totalRows);
  if (done && !process.argv.includes('--reimport')) {
    console.log(`catalogue: already imported (import #${done.id}); pass --reimport to run it again`);
  } else {
    const buffer = readFileSync(join(import.meta.dirname, '..', '..', '..', FILE_NAME));
    const imports = new ImportService({ prisma, readFile: async () => buffer, enqueue: { validate: async () => {}, apply: async () => {} } });
    const actor = { userId: admin.id, role: admin.role };
    const [media] = await prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, uploaded_by, updated_at)
      VALUES (${`private/catalog-import/demo-${Date.now()}.xlsx`}, 'PRIVATE', 'DOCUMENT', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ${buffer.length}, 'import', 'READY', ${admin.id}, now())
      RETURNING id`;
    const imp = await imports.create({ kind: 'CATALOG', fileMediaId: media!.id, createMissing: true, fileName: FILE_NAME }, actor);
    if ((await imports.validate(imp.id, true)) !== 'VALIDATED') throw new Error(`import #${imp.id} failed its check; open it in the admin (Imports) to see why`);
    await imports.confirm(imp.id, actor);
    while ((await imports.apply(imp.id)) === 'DONE' && (await prisma.productImport.findUniqueOrThrow({ where: { id: imp.id } })).status === 'IMPORTING');
    const r = await prisma.productImport.findUniqueOrThrow({ where: { id: imp.id } });
    console.log(`catalogue: import #${r.id} ${r.status}: ${r.createdCount} created, ${r.updatedCount} updated, ${r.unchangedCount} unchanged, ${r.reviewCount} to review, ${r.failedCount} failed`);
  }

  // 2. Reference order for the types the import created (others keep their place after them)
  const types = await prisma.productType.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  const rank = (name: string) => { const i = REFERENCE_ORDER.findIndex((n) => n.toLowerCase() === name.toLowerCase()); return i === -1 ? REFERENCE_ORDER.length : i; };
  const ordered = [...types].sort((a, b) => rank(a.name) - rank(b.name) || a.sortOrder - b.sortOrder || a.id - b.id);
  for (const [i, t] of ordered.entries()) if (t.sortOrder !== i) await prisma.productType.update({ where: { id: t.id }, data: { sortOrder: i } });

  // The section order as first seeded (before product.md §5.1's order became the default): move it, unless changed.
  const OLD_DEFAULT = ['hero', 'types', 'trending', 'new-arrivals', 'techniques', 'reels', 'testimonials', 'instagram'];
  const sections = await prisma.setting.findUnique({ where: { key: 'HOME_SECTIONS' } });
  if (sections && JSON.stringify((sections.value as { order?: unknown }).order) === JSON.stringify(OLD_DEFAULT)) {
    await prisma.setting.update({ where: { key: 'HOME_SECTIONS' }, data: { value: DEFAULT_SETTINGS.HOME_SECTIONS } });
  }

  // 3. Sample contact details, never over the owner's own
  const store = parseSetting('STORE_INFO', (await prisma.setting.findUniqueOrThrow({ where: { key: 'STORE_INFO' } })).value);
  if (!store.whatsapp) await prisma.setting.update({ where: { key: 'STORE_INFO' }, data: { value: { ...store, whatsapp: DEMO_CONTACT.whatsapp } } });
  const social = parseSetting('SOCIAL', (await prisma.setting.findUnique({ where: { key: 'SOCIAL' } }))?.value ?? DEFAULT_SETTINGS.SOCIAL);
  if (!social.instagram) await prisma.setting.update({ where: { key: 'SOCIAL' }, data: { value: { ...social, instagram: DEMO_CONTACT.instagram } } });

  // 4. Showcase (storage settings as in .env.example unless set)
  if (!process.argv.includes('--no-showcase')) {
    const e = (k: string, d: string) => process.env[k] ?? d;
    const store = new S3ObjectStore({ endpoint: e('S3_ENDPOINT', 'http://localhost:9090'), region: e('S3_REGION', 'auto'), accessKeyId: e('S3_ACCESS_KEY_ID', 'local'), secretAccessKey: e('S3_SECRET_ACCESS_KEY', 'local'), forcePathStyle: e('S3_FORCE_PATH_STYLE', 'true') === 'true' });
    const buckets = { PUBLIC: e('S3_BUCKET_PUBLIC', 'artq-public'), PRIVATE: e('S3_BUCKET_PRIVATE', 'artq-private') };
    const media = new MediaService(prisma, { store, buckets, publicBaseUrl: e('MEDIA_PUBLIC_BASE_URL', `${e('S3_ENDPOINT', 'http://localhost:9090')}/${buckets.PUBLIC}`) }, async () => {});
    const r = await seedShowcase({ prisma, media, store, bucket: buckets.PUBLIC, admin });
    console.log(`showcase: ${r.published.length} live products, ${r.images} new demo images`);
    for (const s of r.skipped) console.log(`  not published: ${s}`);
  }

  const summary = await prisma.productType.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { name: true, isActive: true, _count: { select: { categories: true, products: true } } } });
  console.log('types (menu order):');
  for (const t of summary) console.log(`  ${t.name}: ${t._count.categories} categories, ${t._count.products} products${t.isActive ? '' : ' (inactive)'}`);
  console.log(`products: ${await prisma.product.count({ where: { deletedAt: null } })}, live: ${await prisma.product.count({ where: { deletedAt: null, status: 'ACTIVE' } })} (the rest stay drafts until finished and published in the admin)`);
} finally {
  await prisma.$disconnect();
}
