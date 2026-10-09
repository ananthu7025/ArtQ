// Demo showcase for local testing (part of `db:seed:demo`): turns a dozen imported drafts into live products the way an
// admin would, so the storefront has something to show before the client's real photos, weights, counts and tax codes
// arrive (decision D-10). Every value written here is marked as demo data. Stock goes through aq_adjust_on_hand and
// publishing through the real publication gate (CatalogService.setStatus), so nothing bypasses the shop's rules.
// Images are generated (sharp from SVG), uploaded to the public bucket and processed like real uploads.
import type { PrismaClient, User } from '@prisma/client';
import sharp from 'sharp';
import { CatalogService } from '../src/catalog/service.js';
import * as fn from '../src/db/functions.js';
import { storeReadiness } from '../src/imports/service.js';
import type { MediaService } from '../src/media/service.js';
import type { ObjectStore } from '../src/media/storage.js';

const PALETTE = ['#00756f', '#005f5a', '#00627a', '#7c2d12', '#b45309', '#374151', '#1e40af', '#15803d'];
const HSN: Record<string, string> = { resin: '3907', frame: '4414', pigment: '3206', glitter: '3920', hoop: '4421', silica: '2811' };
const TECHNIQUES = ['Resin Art', 'Coasters', 'Jewellery Making', 'Home Decor'];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** A simple branded picture: colour field, a "resin pour" shape, the name and a DEMO PHOTO tag. */
function svg(label: string, color: string, w: number, h: number, round = false) {
  const words = label.split(/\s+/);
  const lines: string[] = [];
  for (const word of words) { const last = lines.at(-1); if (last && `${last} ${word}`.length <= 18) lines[lines.length - 1] = `${last} ${word}`; else lines.push(word); }
  const size = Math.round(Math.min(w, h) / 12);
  const text = lines.slice(0, 4).map((l, i) => `<text x="50%" y="${h / 2 + (i - (Math.min(lines.length, 4) - 1) / 2) * size * 1.25}" font-family="Georgia, serif" font-size="${size}" fill="#fff" text-anchor="middle" dominant-baseline="middle">${esc(l)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><radialGradient id="g" cx="30%" cy="30%" r="80%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>
    <rect width="${w}" height="${h}" fill="${color}"/>
    <circle cx="${w * 0.72}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.28}" fill="url(#g)"/>
    <circle cx="${w * 0.25}" cy="${h * 0.78}" r="${Math.min(w, h) * 0.18}" fill="#ffffff" fill-opacity="0.12"/>
    ${round ? '' : text}
    ${round ? '' : `<text x="${w - 24}" y="${h - 24}" font-family="sans-serif" font-size="${Math.max(14, size / 3)}" fill="#fff" fill-opacity="0.8" text-anchor="end">DEMO PHOTO</text>`}
  </svg>`;
}

export type ShowcaseDeps = { prisma: PrismaClient; media: MediaService; store: ObjectStore; bucket: string; admin: User };
export type ShowcaseReport = { published: string[]; skipped: string[]; images: number };

export async function seedShowcase(d: ShowcaseDeps): Promise<ShowcaseReport> {
  const { prisma, admin } = d;
  const report: ShowcaseReport = { published: [], skipped: [], images: 0 };

  // Earlier runs tagged demo images 'product'; the admin only accepts 'admin' images, so editing a demo product's photos
  // failed. Fix any such rows (re-runnable).
  await prisma.media.updateMany({ where: { key: { startsWith: 'public/demo/' }, ownerScope: { not: 'admin' } }, data: { ownerScope: 'admin' } });

  /** Generated image, uploaded and processed like an upload, owned like an admin upload (ownerScope 'admin'); reused on later runs (same key). */
  const image = async (key: string, label: string, color: string, w = 1200, h = 1200, round = false): Promise<number> => {
    const fullKey = `public/demo/${key}.png`;
    const existing = await prisma.media.findUnique({ where: { key: fullKey } });
    if (existing?.status === 'READY') return existing.id;
    const body = await sharp(Buffer.from(svg(label, color, w, h, round))).png().toBuffer();
    await d.store.put(d.bucket, fullKey, body, 'image/png', 'public, max-age=31536000, immutable');
    const m = existing
      ? await prisma.media.update({ where: { id: existing.id }, data: { status: 'UPLOADED', declaredSize: body.length, failureReason: null } })
      : await prisma.media.create({ data: { key: fullKey, visibility: 'PUBLIC', kind: 'IMAGE', declaredMime: 'image/png', declaredSize: body.length, ownerScope: 'admin', status: 'UPLOADED', uploadedBy: admin.id } });
    if ((await d.media.process(m.id)) !== 'READY') throw new Error(`demo image ${key} was not accepted`);
    report.images++;
    return m.id;
  };

  // Type tiles (range circles) for types without an image.
  const types = await prisma.productType.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  for (const [i, t] of types.entries()) {
    if (!t.imageMediaId) await prisma.productType.update({ where: { id: t.id }, data: { imageMediaId: await image(`type-${t.slug}`, t.name, PALETTE[i % PALETTE.length]!, 480, 480, true) } });
  }

  // Up to two drafts per type whose variants all have a price and a normalised size: the ones an admin could finish.
  const candidates = await prisma.$queryRaw<{ id: number; name: string; slug: string; type_name: string; type_sort: number; status: string }[]>`
    SELECT p.id, p.name, p.slug, t.name AS type_name, t.sort_order AS type_sort, p.status::text
    FROM products p JOIN product_types t ON t.id = p.type_id
    WHERE p.deleted_at IS NULL AND p.category_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active AND v.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active AND v.deleted_at IS NULL
                        AND (v.price IS NULL OR v.net_quantity IS NULL OR v.net_unit IS NULL))
    ORDER BY t.sort_order, t.id, p.id`;
  const perType = new Map<string, number>();
  const chosen = candidates.filter((c) => { const n = perType.get(c.type_name) ?? 0; if (n >= 2) return false; perType.set(c.type_name, n + 1); return true; }).slice(0, 12);

  const catalog = new CatalogService(prisma);
  const actor = { userId: admin.id, seeCost: true, audit: async (db: Pick<PrismaClient, 'auditLog'>, e: { action: string; entity: string; entityId?: string | number | null; before?: unknown; after?: unknown }) => {
    await db.auditLog.create({ data: { actorId: admin.id, action: e.action, entity: e.entity, entityId: e.entityId == null ? null : String(e.entityId), ...(e.before === undefined ? {} : { before: e.before as object }), after: { ...(e.after as object ?? {}), demoSeed: true } } });
  } };

  for (const [i, c] of chosen.entries()) {
    if (c.status === 'ACTIVE') { report.published.push(c.name); continue; }
    const color = PALETTE[c.type_sort % PALETTE.length]!;
    const hsn = Object.entries(HSN).find(([k]) => c.type_name.toLowerCase().includes(k))?.[1] ?? '3907';
    // What the owner would fill in: description, measured weight, tax approval, resolved import flags.
    await prisma.$executeRaw`UPDATE products SET data_flags = '{}', description = coalesce(nullif(btrim(description), ''), ${`Demo description for ${c.name}. Replace with the real product copy.`}),
      hsn_code = coalesce(hsn_code, ${hsn}), gst_rate = coalesce(gst_rate, 18), tax_approved_at = now(), tax_approved_by = ${admin.id},
      is_new_arrival = ${i < 5}, new_arrival_rank = ${i < 5 ? i + 1 : null}, is_trending = ${i >= 5 && i < 9}, trending_rank = ${i >= 5 && i < 9 ? i - 4 : null}
      WHERE id = ${c.id}`;
    await prisma.$executeRaw`UPDATE product_variants SET data_flags = '{}', weight_g = coalesce(weight_g, 300), weight_source = 'MEASURED',
      length_cm = CASE WHEN shipping_class = 'BULKY' THEN coalesce(length_cm, 30) END, width_cm = CASE WHEN shipping_class = 'BULKY' THEN coalesce(width_cm, 20) END,
      height_cm = CASE WHEN shipping_class = 'BULKY' THEN coalesce(height_cm, 10) END
      WHERE product_id = ${c.id} AND is_active AND deleted_at IS NULL`;
    // Counted stock through the stock function: mostly in stock, one low, the last product's last size sold out.
    const variants = await prisma.productVariant.findMany({ where: { productId: c.id, isActive: true, deletedAt: null }, orderBy: { id: 'asc' } });
    await prisma.$transaction((tx) => fn.adjustOnHand(tx, { actorId: admin.id, rows: variants.map((v, j) => ({
      variantId: v.id, kind: 'RECOUNT' as const, quantity: i === chosen.length - 1 && j === variants.length - 1 ? 0 : i === 3 ? 3 : 25, note: 'Demo count',
    })) }));
    // Two photos: cover and the hover image.
    const existing = await prisma.productImage.count({ where: { productId: c.id } });
    if (existing === 0) {
      await prisma.productImage.create({ data: { productId: c.id, mediaId: await image(`product-${c.slug}-1`, c.name, color), alt: `${c.name} (demo photo)`, sortOrder: 0, isCover: true } });
      await prisma.productImage.create({ data: { productId: c.id, mediaId: await image(`product-${c.slug}-2`, `${c.type_name}`, PALETTE[(c.type_sort + 3) % PALETTE.length]!), alt: `${c.name}, second view (demo photo)`, sortOrder: 1 } });
    }
    await fn.refreshProducts(prisma, [c.id]);
    await storeReadiness(prisma, [c.id]);
    try {
      await catalog.setStatus(c.id, 'publish', actor);
      report.published.push(c.name);
    } catch (e) {
      report.skipped.push(`${c.name}: ${(e as { details?: unknown }).details ? JSON.stringify((e as { details?: unknown }).details) : (e as Error).message}`);
    }
  }

  // Technique tiles: images for the techniques the import created; sample techniques only when there are none.
  const live = await prisma.product.findMany({ where: { status: 'ACTIVE', deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true } });
  if ((await prisma.technique.count()) === 0) {
    for (const [i, name] of TECHNIQUES.entries()) {
      const t = await prisma.technique.create({ data: { name, slug: name.toLowerCase().replace(/\W+/g, '-'), sortOrder: i } });
      for (const p of live.filter((_, j) => j % TECHNIQUES.length === i)) await prisma.productTechnique.create({ data: { productId: p.id, techniqueId: t.id } });
    }
  }
  for (const [i, t] of (await prisma.technique.findMany({ where: { imageMediaId: null }, orderBy: { id: 'asc' } })).entries()) {
    await prisma.technique.update({ where: { id: t.id }, data: { imageMediaId: await image(`technique-${t.slug}`, t.name, PALETTE[(i + 2) % PALETTE.length]!, 800, 600) } });
  }

  // Sample reviews, clearly labelled, only while there are none.
  if ((await prisma.testimonial.count()) === 0) {
    const samples = [
      ['Sample review', 'Kochi', 'Demo testimonial: the resin cured crystal clear with no bubbles. Replace with a real customer story.', 5],
      ['Sample review', 'Bengaluru', 'Demo testimonial: the frames arrived well packed and the pigments mix beautifully.', 5],
      ['Sample review', 'Pune', 'Demo testimonial: quick delivery and helpful answers on WhatsApp.', 4],
    ] as const;
    for (const [i, [name, location, quote, rating]] of samples.entries()) {
      await prisma.testimonial.create({ data: { name, location, quote, rating, sortOrder: i, productId: live[i]?.id ?? null } });
    }
  }

  // Placeholder pages for the footer links (task 6.2), clearly marked, only while a page is missing; the owner replaces
  // the wording (decision D-5 and the accountant's input) in CMS & Messages.
  const placeholder = (what: string) => `<p><strong>Placeholder:</strong> replace this with ArtQ’s ${what} in CMS &amp; Messages → Pages.</p>`;
  const PAGES: [string, string, string][] = [
    ['about', 'About Our Craft', `${placeholder('story')}<p>Handcrafted resin art and wooden frames, bringing natural beauty into your everyday spaces.</p>`],
    ['terms', 'Terms & Conditions', placeholder('terms and conditions')],
    ['privacy-policy', 'Privacy Policy', placeholder('privacy policy')],
    ['shipping-policy', 'Shipping Policy', `${placeholder('shipping policy')}<p>We ship across India; most orders arrive in 4 to 7 days.</p>`],
    ['return-policy', 'Return & Refund Policy', `${placeholder('return and refund policy')}<p>Damaged, wrong, defective or missing items can be reported within 48 hours of delivery, with photos.</p>`],
    ['cancellation-policy', 'Cancellation Policy', `${placeholder('cancellation policy')}<p>Orders can be cancelled until they are packed; prepaid orders are refunded in full.</p>`],
  ];
  for (const [slug, title, content] of PAGES) {
    if (!(await prisma.cmsPage.findUnique({ where: { slug } }))) await prisma.cmsPage.create({ data: { slug, title, content } });
  }
  if ((await prisma.faq.count()) === 0) {
    const faqs = [
      ['SHIPPING', 'How long does delivery take?', 'Most orders arrive in 4 to 7 days across India. You get a tracking link by email when your order ships.'],
      ['PAYMENTS', 'Can I pay cash on delivery?', 'Yes, for orders between ₹200 and ₹5,000 to pincodes where the courier accepts cash. A small COD fee applies.'],
      ['RETURNS', 'What if my order arrives damaged?', 'Report it from your order page within 48 hours of delivery, with photos. We replace or refund damaged, wrong, defective or missing items.'],
      ['ORDERS', 'Can I cancel my order?', 'Yes, until it is packed. Open the order from your account or the link in your order email.'],
    ] as const;
    for (const [i, [group, question, answer]] of faqs.entries()) await prisma.faq.create({ data: { group, question, answer, sortOrder: i } });
  }

  // A hero image (no demo video), only while there are no slides.
  if ((await prisma.homeSlide.count()) === 0) {
    await prisma.homeSlide.create({ data: { ctaText: 'Shop now', ctaLink: '/shop', mediaId: await image('hero', '', '#005f5a', 1920, 1080, true), sortOrder: 0 } });
  }
  return report;
}
