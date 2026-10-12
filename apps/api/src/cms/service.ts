// CMS & Messages (task 6.1; api.md §4.10 "CMS", product.md §7.5) [content:write]. Hero slides, reels, testimonials and
// FAQs (create, edit, delete, reorder, on/off), content pages (rich text, cleaned like product descriptions), the home
// settings edited by content staff (announcement bar, home sections, hero timing, Instagram, social links) and the
// messages inbox (contact form and custom work, with private attachments). Every change is audited in its transaction.
// The home page reads these records directly (task 3.3) and the public settings are cached: they are dropped after a
// settings change.
import type { faqBody, pageBody, reelBody, slideBody, testimonialBody} from '@artq/shared';
import {
  CMS_SETTING_BODIES, POLICY_SLUGS,
  type AdminMessageDetail, type AdminMessageRow, type CmsFaq, type CmsMedia, type CmsPageDetail, type CmsPageRow, type CmsReel, type CmsSettingKey, type CmsSlide, type CmsTestimonial,
  type messageListQuery, type messagePatchBody,
} from '@artq/shared';
import type { Media, Prisma, PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import { sanitizeDescription } from '../catalog/rich-text.js';
import { assertUsableImages } from '../catalog/media-check.js';
import { AppError } from '../lib/errors.js';
import type { AppCache } from '../lib/app-cache.js';

type Tx = Prisma.TransactionClient;
export type Audit = (tx: Tx, e: { action: string; entity: string; entityId: string | number; before?: unknown; after?: unknown }) => Promise<void>;
/** Public media → CDN rendition URLs (MediaService.view). */
export type RenderMedia = (m: Media) => { renditions: Record<string, string> };
export type PrivateUrl = (mediaId: number, rendition?: string) => Promise<string>;
export type Sortable = 'slides' | 'reels' | 'testimonials' | 'faqs';

const TX = { maxWait: 10_000, timeout: 20_000 } as const;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const ENTITY: Record<Sortable, { table: string; entity: string; label: string }> = {
  slides: { table: 'home_slides', entity: 'home_slide', label: 'Slide' },
  reels: { table: 'reels', entity: 'reel', label: 'Reel' },
  testimonials: { table: 'testimonials', entity: 'testimonial', label: 'Testimonial' },
  faqs: { table: 'faqs', entity: 'faq', label: 'FAQ' },
};
const model = (db: Tx | PrismaClient, k: Sortable) => ({ slides: db.homeSlide, reels: db.reel, testimonials: db.testimonial, faqs: db.faq }[k] as unknown as {
  findMany(a: object): Promise<{ id: number; sortOrder: number }[]>; findUnique(a: object): Promise<Record<string, unknown> | null>;
  create(a: object): Promise<{ id: number }>; update(a: object): Promise<unknown>; delete(a: object): Promise<unknown>; aggregate(a: object): Promise<{ _max: { sortOrder: number | null } }>;
});

/** A public video uploaded through the admin pipeline (uploaded, processing or ready). */
async function assertUsableVideo(db: Tx, id: number) {
  const ok = await db.media.findFirst({ where: { id, kind: 'VIDEO', visibility: 'PUBLIC', ownerScope: 'admin', deletedAt: null, status: { in: ['UPLOADED', 'PROCESSING', 'READY'] } }, select: { id: true } });
  if (!ok) throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'videoMediaId', message: 'Choose an uploaded video' }]);
  await db.media.updateMany({ where: { id, claimedAt: null }, data: { claimedAt: new Date() } });
}
async function images(db: Tx, fields: Record<string, number | null>) {
  for (const [path, id] of Object.entries(fields)) {
    if (id === null) continue;
    try { await assertUsableImages(db, [id]); }
    catch { throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path, message: 'Choose an uploaded image' }]); }
  }
}
async function product(db: Tx, id: number | null) {
  if (id !== null && !(await db.product.findFirst({ where: { id, deletedAt: null }, select: { id: true } }))) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'productId', message: 'This product no longer exists' }]);
  }
}

export class CmsService {
  constructor(private readonly prisma: PrismaClient, private readonly render: RenderMedia, private readonly cache: AppCache, private readonly mediaUrl: (key: string) => string) {}

  private media(m: Media | null | undefined): CmsMedia | null {
    if (!m) return null;
    if (m.kind === 'VIDEO') return { id: m.id, url: m.status === 'READY' ? this.mediaUrl(m.key) : null, status: m.status };
    const r = this.render(m).renditions;
    return { id: m.id, url: r['320'] ?? r['160'] ?? Object.values(r)[0] ?? null, status: m.status };
  }

  // ── Sortable content ──
  async list(k: 'slides'): Promise<CmsSlide[]>;
  async list(k: 'reels'): Promise<CmsReel[]>;
  async list(k: 'testimonials'): Promise<CmsTestimonial[]>;
  async list(k: 'faqs'): Promise<CmsFaq[]>;
  async list(k: Sortable): Promise<unknown[]> {
    const order = [{ sortOrder: 'asc' as const }, { id: 'asc' as const }];
    const now = Date.now();
    switch (k) {
      case 'slides': return (await this.prisma.homeSlide.findMany({ include: { media: true, mobileMedia: true }, orderBy: order })).map((s): CmsSlide => ({
        id: s.id, heading: s.heading, subheading: s.subheading, ctaText: s.ctaText, ctaLink: s.ctaLink, media: this.media(s.media)!, mobileMedia: this.media(s.mobileMedia),
        isActive: s.isActive, startsAt: iso(s.startsAt), endsAt: iso(s.endsAt), sortOrder: s.sortOrder,
        live: s.isActive && s.media.status === 'READY' && (!s.startsAt || s.startsAt.getTime() <= now) && (!s.endsAt || s.endsAt.getTime() > now),
      }));
      case 'reels': return (await this.prisma.reel.findMany({ include: { video: true, thumbnail: true, product: { select: { id: true, name: true } } }, orderBy: order })).map((r): CmsReel => ({
        id: r.id, title: r.title, video: this.media(r.video)!, thumbnail: this.media(r.thumbnail), product: r.product, instagramUrl: r.instagramUrl, isActive: r.isActive, sortOrder: r.sortOrder,
      }));
      case 'testimonials': return (await this.prisma.testimonial.findMany({ include: { avatar: true, product: { select: { id: true, name: true } } }, orderBy: order })).map((t): CmsTestimonial => ({
        id: t.id, name: t.name, location: t.location, quote: t.quote, rating: t.rating, avatar: this.media(t.avatar), product: t.product, isActive: t.isActive, sortOrder: t.sortOrder,
      }));
      case 'faqs': return (await this.prisma.faq.findMany({ orderBy: [{ group: 'asc' }, ...order] })).map((f): CmsFaq => ({ id: f.id, group: f.group, question: f.question, answer: f.answer, isActive: f.isActive, sortOrder: f.sortOrder }));
    }
  }

  /** Checks references (media, product) and returns the data to store. */
  private async data(tx: Tx, k: Sortable, body: unknown): Promise<Record<string, unknown>> {
    switch (k) {
      case 'slides': {
        const b = body as z.output<typeof slideBody>;
        await images(tx, { mediaId: b.mediaId, mobileMediaId: b.mobileMediaId });
        return { ...b, startsAt: b.startsAt ? new Date(b.startsAt) : null, endsAt: b.endsAt ? new Date(b.endsAt) : null };
      }
      case 'reels': {
        const b = body as z.output<typeof reelBody>;
        await assertUsableVideo(tx, b.videoMediaId);
        await images(tx, { thumbnailMediaId: b.thumbnailMediaId });
        await product(tx, b.productId);
        return { ...b };
      }
      case 'testimonials': {
        const b = body as z.output<typeof testimonialBody>;
        await images(tx, { avatarMediaId: b.avatarMediaId });
        await product(tx, b.productId);
        return { ...b };
      }
      case 'faqs': return { ...(body as z.output<typeof faqBody>) };
    }
  }

  async create(k: Sortable, body: unknown, audit: Audit): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const data = await this.data(tx, k, body);
      const last = await model(tx, k).aggregate({ _max: { sortOrder: true }, ...(k === 'faqs' ? { where: { group: data.group } } : {}) });
      const row = await model(tx, k).create({ data: { ...data, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
      await audit(tx, { action: `${ENTITY[k].entity}.create`, entity: ENTITY[k].entity, entityId: row.id, after: data });
      return row.id;
    }, TX);
  }

  async update(k: Sortable, id: number, body: unknown, audit: Audit): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, k, id);
      const data = await this.data(tx, k, body);
      await model(tx, k).update({ where: { id }, data });
      await audit(tx, { action: `${ENTITY[k].entity}.update`, entity: ENTITY[k].entity, entityId: id, before, after: data });
    }, TX);
  }

  async remove(k: Sortable, id: number, audit: Audit): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, k, id);
      await model(tx, k).delete({ where: { id } });
      await audit(tx, { action: `${ENTITY[k].entity}.delete`, entity: ENTITY[k].entity, entityId: id, before });
    }, TX);
  }

  /** The list order (FAQs: within one group; every id must be in it). */
  async reorder(k: Sortable, ids: number[], audit: Audit): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const found = await model(tx, k).findMany({ where: { id: { in: ids } }, select: { id: true, ...(k === 'faqs' ? { group: true } : {}) } }) as { id: number; group?: string }[];
      const missing = ids.filter((i) => !found.some((f) => f.id === i));
      if (missing.length) throw new AppError(422, 'NOT_FOUND', `Some items no longer exist. Reload and try again.`, { ids: missing });
      if (k === 'faqs' && new Set(found.map((f) => f.group)).size > 1) throw new AppError(422, 'VALIDATION_ERROR', 'Reorder FAQs within one group at a time', [{ location: 'body', path: 'ids', message: 'Reorder FAQs within one group at a time' }]);
      for (const [i, id] of ids.entries()) await model(tx, k).update({ where: { id }, data: { sortOrder: i } });
      await audit(tx, { action: `${ENTITY[k].entity}.reorder`, entity: ENTITY[k].entity, entityId: 'list', after: { ids } });
    }, TX);
  }

  private async lock(tx: Tx, k: Sortable, id: number) {
    const [row] = await tx.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM ${ENTITY[k].table} WHERE id = $1 FOR UPDATE`, id);
    if (!row) throw new AppError(404, 'NOT_FOUND', `${ENTITY[k].label} not found`);
    return model(tx, k).findUnique({ where: { id } });
  }

  // ── Pages ──
  async pages(): Promise<CmsPageRow[]> {
    const rows = await this.prisma.cmsPage.findMany({ orderBy: { slug: 'asc' } });
    const staff = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.updatedBy).filter((x): x is number => x !== null))] } }, select: { id: true, name: true, email: true } });
    return rows.map((p) => ({ id: p.id, slug: p.slug, title: p.title, isPublished: p.isPublished, updatedAt: p.updatedAt.toISOString(), updatedBy: (() => { const u = staff.find((s) => s.id === p.updatedBy); return u ? (u.name ?? u.email) : null; })() }));
  }

  async page(id: number): Promise<CmsPageDetail> {
    const p = await this.prisma.cmsPage.findUnique({ where: { id } });
    if (!p) throw new AppError(404, 'NOT_FOUND', 'Page not found');
    const u = p.updatedBy ? await this.prisma.user.findUnique({ where: { id: p.updatedBy }, select: { name: true, email: true } }) : null;
    return { id: p.id, slug: p.slug, title: p.title, isPublished: p.isPublished, updatedAt: p.updatedAt.toISOString(), updatedBy: u ? (u.name ?? u.email) : null, content: p.content, metaTitle: p.metaTitle, metaDescription: p.metaDescription };
  }

  async savePage(id: number | null, b: z.output<typeof pageBody>, actorId: number, audit: Audit): Promise<number> {
    const content = sanitizeDescription(b.content);
    const field = (path: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path, message }]);
    if (!content) throw field('content', 'Write the page');
    return this.prisma.$transaction(async (tx) => {
      const taken = await tx.cmsPage.findUnique({ where: { slug: b.slug }, select: { id: true } });
      if (taken && taken.id !== id) throw field('slug', 'Another page already uses this address');
      const data = { ...b, content, updatedBy: actorId };
      if (id === null) {
        const row = await tx.cmsPage.create({ data });
        await audit(tx, { action: 'cms_page.create', entity: 'cms_page', entityId: row.id, after: { slug: b.slug, title: b.title, isPublished: b.isPublished } });
        return row.id;
      }
      const [locked] = await tx.$queryRaw<{ id: number; slug: string }[]>`SELECT id, slug FROM cms_pages WHERE id = ${id} FOR UPDATE`;
      if (!locked) throw new AppError(404, 'NOT_FOUND', 'Page not found');
      if ((POLICY_SLUGS as readonly string[]).includes(locked.slug) && b.slug !== locked.slug) throw field('slug', 'This page’s address is used by the site footer; it can’t change');
      await tx.cmsPage.update({ where: { id }, data });
      await audit(tx, { action: 'cms_page.update', entity: 'cms_page', entityId: id, before: { slug: locked.slug }, after: { slug: b.slug, title: b.title, isPublished: b.isPublished } });
      return id;
    }, TX);
  }

  async removePage(id: number, audit: Audit): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.cmsPage.findUnique({ where: { id }, select: { slug: true, title: true } });
      if (!p) throw new AppError(404, 'NOT_FOUND', 'Page not found');
      if ((POLICY_SLUGS as readonly string[]).includes(p.slug)) throw new AppError(409, 'UNPUBLISH_INSTEAD', 'The site links to this page, so it can’t be deleted. Unpublish it instead.');
      await tx.cmsPage.delete({ where: { id } });
      await audit(tx, { action: 'cms_page.delete', entity: 'cms_page', entityId: id, before: p });
    }, TX);
  }

  // ── Home settings ──
  async settings(): Promise<Record<CmsSettingKey, unknown>> {
    const rows = await this.prisma.setting.findMany({ where: { key: { in: Object.keys(CMS_SETTING_BODIES) as never } } });
    return Object.fromEntries(Object.keys(CMS_SETTING_BODIES).map((k) => [k, rows.find((r) => r.key === k)?.value ?? null])) as Record<CmsSettingKey, unknown>;
  }

  async saveSetting(key: CmsSettingKey, value: unknown, actorId: number, audit: Audit): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.setting.findUnique({ where: { key }, select: { value: true } });
      await tx.setting.upsert({ where: { key }, update: { value: value as Prisma.InputJsonValue, updatedBy: actorId }, create: { key, value: value as Prisma.InputJsonValue, isPublic: true, updatedBy: actorId } });
      await audit(tx, { action: 'setting.update', entity: 'setting', entityId: key, before: before?.value ?? null, after: value });
    }, TX);
    await this.cache.invalidate('publicSettings');
  }

  // ── Messages ──
  async messages(q: z.output<typeof messageListQuery>) {
    const text = q.q?.trim();
    const where: Prisma.ContactMessageWhereInput = {
      ...(q.kind ? { kind: q.kind } : {}), ...(q.status ? { status: q.status } : q.open ? { status: { not: 'CLOSED' } } : {}),
      ...(text ? { OR: [{ email: { contains: text, mode: 'insensitive' } }, { name: { contains: text, mode: 'insensitive' } }, { subject: { contains: text, mode: 'insensitive' } }, { orderNumber: { equals: text.toUpperCase() } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.contactMessage.count({ where }),
      this.prisma.contactMessage.findMany({ where, include: { _count: { select: { attachments: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    return { data: rows.map((m) => this.messageRow(m, m._count.attachments)), meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
  }

  private messageRow(m: Prisma.ContactMessageGetPayload<object>, attachments: number): AdminMessageRow {
    return { id: m.id, kind: m.kind, name: m.name, email: m.email, phone: m.phone, subject: m.subject, preview: m.message.slice(0, 140), orderNumber: m.orderNumber, status: m.status, attachments, createdAt: m.createdAt.toISOString() };
  }

  async message(id: number, privateUrl: PrivateUrl): Promise<AdminMessageDetail> {
    const m = await this.prisma.contactMessage.findUnique({ where: { id }, include: { attachments: { include: { media: { select: { id: true, renditions: true, status: true } } } } } });
    if (!m) throw new AppError(404, 'NOT_FOUND', 'Message not found');
    const files = await Promise.all(m.attachments.filter((a) => a.media.status === 'READY').map(async (a) => {
      const r = (a.media.renditions ?? {}) as Record<string, string>;
      return { id: a.mediaId, url: await privateUrl(a.mediaId), thumbUrl: r['320'] ? await privateUrl(a.mediaId, '320') : null };
    }));
    return { ...this.messageRow(m, m.attachments.length), message: m.message, details: (m.details as Record<string, unknown> | null) ?? null, adminNote: m.adminNote, files };
  }

  async patchMessage(id: number, b: z.output<typeof messagePatchBody>, audit: Audit): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.contactMessage.findUnique({ where: { id }, select: { status: true, adminNote: true } });
      if (!before) throw new AppError(404, 'NOT_FOUND', 'Message not found');
      await tx.contactMessage.update({ where: { id }, data: { ...(b.status ? { status: b.status } : {}), ...(b.adminNote !== undefined ? { adminNote: b.adminNote } : {}) } });
      await audit(tx, { action: 'message.update', entity: 'contact_message', entityId: id, before, after: b });
    }, TX);
  }
}
