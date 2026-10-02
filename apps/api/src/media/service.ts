// Media pipeline (architecture.md §9.1–9.2, database.md §3.4):
//   presign (allow-list per purpose, PENDING_UPLOAD) → browser PUTs to storage → complete (owner only, HEAD check →
//   UPLOADED, enqueue) → worker: magic-byte sniff, sharp decode + WebP renditions, SHA-256 → READY / REJECTED / FAILED.
// Private media are served only through an authorization check and a 5-minute presigned GET.
import { createHash, randomUUID } from 'node:crypto';
import { can, type Permission, type Role } from '@artq/shared';
import type { Media, Prisma, PrismaClient } from '@prisma/client';
import { fileTypeFromBuffer } from 'file-type';
import sharp, { type Metadata } from 'sharp';
import { AppError } from '../lib/errors.js';
import { normaliseSourceUrl, safeFetch, SafeFetchError, type SafeFetchResult } from '../lib/safe-fetch.js';
import type { ObjectStore } from './storage.js';

const MB = 1024 * 1024;
const IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;
const VIDEO = ['video/mp4', 'video/webm'] as const;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type Audience = 'admin' | 'customer';
type Rule = { audience: Audience; kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; mimes: readonly string[]; maxBytes: number; visibility: 'PUBLIC' | 'PRIVATE' };

/** Upload allow-list (architecture.md §9.1). */
export const PURPOSES = {
  'product-image': { audience: 'admin', kind: 'IMAGE', mimes: IMAGE, maxBytes: 15 * MB, visibility: 'PUBLIC' },
  'cms-image': { audience: 'admin', kind: 'IMAGE', mimes: IMAGE, maxBytes: 15 * MB, visibility: 'PUBLIC' },
  'video': { audience: 'admin', kind: 'VIDEO', mimes: VIDEO, maxBytes: 50 * MB, visibility: 'PUBLIC' },
  'catalog-import': { audience: 'admin', kind: 'DOCUMENT', mimes: [XLSX], maxBytes: 5 * MB, visibility: 'PRIVATE' },
  'custom-work': { audience: 'customer', kind: 'IMAGE', mimes: IMAGE, maxBytes: 8 * MB, visibility: 'PRIVATE' },
  'return-photo': { audience: 'customer', kind: 'IMAGE', mimes: IMAGE, maxBytes: 8 * MB, visibility: 'PRIVATE' },
} as const satisfies Record<string, Rule>;
export type Purpose = keyof typeof PURPOSES;

export const RENDITION_WIDTHS = [160, 320, 640, 960, 1280, 1600] as const;
export const UPLOAD_URL_TTL_S = 300;
export const PRIVATE_URL_TTL_S = 300;
export const MAX_INPUT_PIXELS = 40_000_000;
const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif', 'video/mp4': '.mp4', 'video/webm': '.webm', [XLSX]: '.xlsx' };

export type MediaConfig = { store: ObjectStore; buckets: { PUBLIC: string; PRIVATE: string }; publicBaseUrl: string };

/** Who is acting. `scope` is required for customer purposes (e.g. `return:<orderId>`, `custom-work:<cartTokenHash>`). */
export type Actor = { userId: number | null; audience: Audience; role?: Role; scope?: string };

export type MediaView = {
  id: number; kind: string; visibility: string; status: string; mime: string; size: number; width: number | null; height: number | null;
  failureReason: string | null; renditions: Record<string, string>; placeholder: string | null;
};

const notFound = () => new AppError(404, 'NOT_FOUND', 'Media not found');

export class MediaService {
  constructor(private readonly prisma: PrismaClient, private readonly cfg: MediaConfig, private readonly enqueue: (mediaId: number) => Promise<void>) {}

  view(m: Media): MediaView {
    const r = (m.renditions ?? {}) as Record<string, string>;
    const base = m.visibility === 'PUBLIC' ? this.cfg.publicBaseUrl.replace(/\/$/, '') : null;
    return {
      id: m.id, kind: m.kind, visibility: m.visibility, status: m.status, mime: m.detectedMime ?? m.declaredMime, size: m.sizeBytes ?? m.declaredSize,
      width: m.width, height: m.height, failureReason: m.failureReason, placeholder: m.placeholder,
      // Public renditions are CDN URLs; private ones are only reachable through the authorized redirect.
      renditions: base ? Object.fromEntries(Object.entries(r).map(([w, key]) => [w, `${base}/${key}`])) : {},
    };
  }

  async presign(input: { filename: string; contentType: string; size: number; purpose: Purpose }, actor: Actor) {
    const rule: Rule = PURPOSES[input.purpose];
    if (!rule || rule.audience !== actor.audience) throw new AppError(403, 'FORBIDDEN', 'This upload purpose is not available here');
    if (!rule.mimes.includes(input.contentType)) {
      throw new AppError(422, 'MEDIA_TYPE_NOT_ALLOWED', `Allowed types: ${rule.mimes.join(', ')}`, { allowed: rule.mimes });
    }
    if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > rule.maxBytes) {
      throw new AppError(422, 'MEDIA_TOO_LARGE', `Maximum size is ${rule.maxBytes / MB} MB`, { maxBytes: rule.maxBytes });
    }
    const ownerScope = rule.audience === 'admin' ? (input.purpose === 'catalog-import' ? 'import' : 'admin') : actor.scope;
    if (!ownerScope) throw new AppError(400, 'VALIDATION_ERROR', 'An owner scope is required for this upload');
    // The storage key never contains the user's file name.
    const key = `${rule.visibility.toLowerCase()}/${input.purpose}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}${EXT[input.contentType]}`;
    const media = await this.prisma.media.create({
      data: { key, visibility: rule.visibility, kind: rule.kind, declaredMime: input.contentType, declaredSize: input.size, uploadedBy: actor.userId, ownerScope, status: 'PENDING_UPLOAD' },
    });
    const url = await this.cfg.store.presignPut(this.cfg.buckets[rule.visibility], key, { contentType: input.contentType, contentLength: input.size, expiresIn: UPLOAD_URL_TTL_S });
    return {
      media: this.view(media),
      upload: { method: 'PUT' as const, url, headers: { 'Content-Type': input.contentType, 'Content-Length': String(input.size) }, expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_S * 1000).toISOString() },
    };
  }

  /** Only the uploader (same user, or same scope for guest uploads) may complete; anyone else gets 404. */
  private owns(m: Media, actor: Actor): boolean {
    if (m.deletedAt) return false;
    if (actor.audience === 'admin') return m.uploadedBy !== null && m.uploadedBy === actor.userId && (m.ownerScope === 'admin' || m.ownerScope === 'import');
    if (m.ownerScope !== actor.scope) return false;
    return m.uploadedBy === null ? actor.userId === null : m.uploadedBy === actor.userId;
  }

  async complete(mediaId: number, actor: Actor): Promise<MediaView> {
    const m = await this.prisma.media.findUnique({ where: { id: mediaId } });
    if (!m || !this.owns(m, actor)) throw notFound();
    if (m.status !== 'PENDING_UPLOAD') return this.view(m);                    // idempotent: completing twice is harmless
    const head = await this.cfg.store.head(this.cfg.buckets[m.visibility], m.key);
    const problem = !head ? 'object not found in storage'
      : head.size !== m.declaredSize ? `size ${head.size} differs from declared ${m.declaredSize}`
      : head.contentType && head.contentType.split(';')[0]!.trim().toLowerCase() !== m.declaredMime ? `content type ${head.contentType} differs from declared ${m.declaredMime}`
      : null;
    if (problem) {
      const rejected = await this.setStatus(m.id, ['PENDING_UPLOAD'], { status: 'REJECTED', failureReason: problem });
      throw new AppError(422, 'MEDIA_REJECTED', problem, { media: this.view(rejected ?? m) });
    }
    const uploaded = await this.setStatus(m.id, ['PENDING_UPLOAD'], { status: 'UPLOADED', sizeBytes: head!.size });
    if (uploaded) await this.enqueue(m.id);
    return this.view(uploaded ?? (await this.prisma.media.findUniqueOrThrow({ where: { id: m.id } })));
  }

  /**
   * Catalogue import images (architecture.md §9.3): download through the SSRF-safe fetcher, store as a public product
   * image and queue it for the same processing as uploads. A URL already ingested and not failed is reused.
   */
  async ingestRemote(url: string, uploadedBy: number | null, fetcher: (url: string) => Promise<SafeFetchResult> = (u) => safeFetch(u)): Promise<number> {
    const source = normaliseSourceUrl(url);
    const known = await this.prisma.media.findFirst({ where: { sourceUrl: source, kind: 'IMAGE', deletedAt: null, status: { in: ['UPLOADED', 'PROCESSING', 'READY'] } }, select: { id: true } });
    if (known) return known.id;
    const r = await fetcher(source);
    const mime = r.contentType.split(';')[0]!.trim().toLowerCase();
    if (!(IMAGE as readonly string[]).includes(mime)) throw new SafeFetchError('NOT_IMAGE', `content type ${mime} is not an allowed image`);
    const key = `public/product-image/${new Date().toISOString().slice(0, 7)}/${randomUUID()}${EXT[mime]}`;
    await this.cfg.store.put(this.cfg.buckets.PUBLIC, key, r.body, mime);
    const m = await this.prisma.media.create({
      data: { key, visibility: 'PUBLIC', kind: 'IMAGE', declaredMime: mime, declaredSize: r.body.length, sizeBytes: r.body.length, sourceUrl: source, uploadedBy, ownerScope: 'admin', status: 'UPLOADED' },
    });
    await this.enqueue(m.id);
    return m.id;
  }

  /** The stored bytes of a media object (e.g. an import workbook), capped at its declared size. */
  read(m: Media): Promise<Buffer> {
    return this.cfg.store.get(this.cfg.buckets[m.visibility], m.key, m.declaredSize);
  }

  /** FAILED (transient) → UPLOADED and re-enqueued. */
  async retry(mediaId: number): Promise<MediaView> {
    const m = await this.setStatus(mediaId, ['FAILED'], { status: 'UPLOADED', failureReason: null });
    if (!m) {
      const cur = await this.prisma.media.findUnique({ where: { id: mediaId } });
      if (!cur || cur.deletedAt) throw notFound();
      throw new AppError(409, 'INVALID_TRANSITION', `Only FAILED media can be retried (status ${cur.status})`);
    }
    await this.enqueue(m.id);
    return this.view(m);
  }

  private async setStatus(id: number, from: Media['status'][], data: Prisma.MediaUpdateManyMutationInput): Promise<Media | null> {
    const r = await this.prisma.media.updateMany({ where: { id, status: { in: from }, deletedAt: null }, data });
    return r.count === 1 ? this.prisma.media.findUniqueOrThrow({ where: { id } }) : null;
  }

  /**
   * Worker step. Returns the final status. Throws only for transient problems (status FAILED, BullMQ retries);
   * anything wrong with the file itself is REJECTED and never retried.
   */
  async process(mediaId: number): Promise<'READY' | 'REJECTED' | 'SKIPPED'> {
    const m = await this.setStatus(mediaId, ['UPLOADED', 'FAILED'], { status: 'PROCESSING' });
    if (!m) return 'SKIPPED';
    const reject = async (reason: string) => { await this.setStatus(m.id, ['PROCESSING'], { status: 'REJECTED', failureReason: reason.slice(0, 500) }); return 'REJECTED' as const; };
    const bucket = this.cfg.buckets[m.visibility];
    let body: Buffer;
    try {
      body = await this.cfg.store.get(bucket, m.key, m.declaredSize);
    } catch (e) {
      if ((e as Error).name === 'ObjectTooLargeError') return reject(`object is larger than the declared ${m.declaredSize} bytes`);
      await this.setStatus(m.id, ['PROCESSING'], { status: 'FAILED', failureReason: `storage: ${(e as Error).message}`.slice(0, 500) });
      throw e;
    }
    if (body.length !== m.declaredSize) return reject(`size ${body.length} differs from declared ${m.declaredSize}`);
    const detected = (await fileTypeFromBuffer(body))?.mime ?? null;
    const allowed = Object.values(PURPOSES).filter((p) => p.kind === m.kind).flatMap((p) => p.mimes as readonly string[]);
    if (detected !== m.declaredMime || !allowed.includes(detected)) return reject(`content is ${detected ?? 'unknown'}, declared ${m.declaredMime}`);
    const checksum = createHash('sha256').update(body).digest('hex');

    if (m.kind !== 'IMAGE') {
      await this.setStatus(m.id, ['PROCESSING'], { status: 'READY', detectedMime: detected, sizeBytes: body.length, checksumSha256: checksum });
      return 'READY';
    }
    let meta: Metadata;
    try {
      meta = await sharp(body, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
      await sharp(body, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).raw().toBuffer({ resolveWithObject: false });   // full decode
    } catch (e) {
      return reject(`image could not be decoded: ${(e as Error).message}`);
    }
    const width = meta.autoOrient?.width ?? meta.width;
    const height = meta.autoOrient?.height ?? meta.height;
    if (!width || !height) return reject('image has no dimensions');
    try {
      const base = m.key.replace(/\.[a-z0-9]+$/, '');
      const widths = [...new Set(RENDITION_WIDTHS.map((w) => Math.min(w, width)))];
      const renditions: Record<string, string> = {};
      for (const w of widths) {
        // rotate() applies EXIF orientation; sharp drops EXIF/GPS and other metadata unless told to keep it.
        const out = await sharp(body, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
        const key = `${base}/w${w}.webp`;
        await this.cfg.store.put(bucket, key, out, 'image/webp', m.visibility === 'PUBLIC' ? 'public, max-age=31536000, immutable' : 'private, no-store');
        renditions[String(w)] = key;
      }
      const tiny = await sharp(body, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize({ width: 16 }).webp({ quality: 40 }).toBuffer();
      await this.setStatus(m.id, ['PROCESSING'], {
        status: 'READY', detectedMime: detected, sizeBytes: body.length, checksumSha256: checksum, width, height,
        renditions, placeholder: `data:image/webp;base64,${tiny.toString('base64')}`, failureReason: null,
      });
      return 'READY';
    } catch (e) {
      await this.setStatus(m.id, ['PROCESSING'], { status: 'FAILED', failureReason: `processing: ${(e as Error).message}`.slice(0, 500) });
      throw e;
    }
  }

  /**
   * Private media access (architecture.md §9.2): every request is authorized; the answer is a 5-minute presigned GET.
   * Staff need the permission for the media's scope; customers must own the upload or the order it belongs to.
   */
  async privateUrl(mediaId: number, actor: Actor, rendition?: string): Promise<string> {
    const m = await this.prisma.media.findUnique({ where: { id: mediaId } });
    if (!m || m.deletedAt || m.visibility !== 'PRIVATE' || !(await this.mayRead(m, actor))) throw notFound();
    const key = rendition ? ((m.renditions ?? {}) as Record<string, string>)[rendition] : m.key;
    if (!key) throw notFound();
    const isImage = m.kind === 'IMAGE';
    return this.cfg.store.presignGet(this.cfg.buckets.PRIVATE, key, { expiresIn: PRIVATE_URL_TTL_S, ...(isImage && rendition ? {} : { attachmentName: `artq-${m.id}${EXT[m.declaredMime] ?? ''}` }) });
  }

  private async mayRead(m: Media, actor: Actor): Promise<boolean> {
    if (actor.audience === 'admin') {
      const need: Permission[] = m.ownerScope === 'import' ? ['imports:catalog']
        : m.ownerScope.startsWith('return:') ? ['returns:decide', 'returns:receive', 'orders:read']
        : m.ownerScope.startsWith('custom-work:') ? ['content:write']
        : ['media:write'];
      return actor.role !== undefined && need.some((p) => can(actor.role!, p));
    }
    if (actor.userId === null) return m.uploadedBy === null && m.ownerScope === actor.scope;      // guest: same scope only
    if (m.uploadedBy === actor.userId) return true;
    const order = /^return:(\d+)$/.exec(m.ownerScope);
    if (order) return (await this.prisma.order.count({ where: { id: Number(order[1]), userId: actor.userId } })) === 1;
    return false;
  }

  /** Marks READY media as attached (called inside the transaction that references it). Scope must match. */
  async claim(tx: Prisma.TransactionClient, mediaId: number, scope: string): Promise<void> {
    const r = await tx.media.updateMany({ where: { id: mediaId, ownerScope: scope, status: 'READY', deletedAt: null }, data: { claimedAt: new Date() } });
    if (r.count !== 1) throw new AppError(422, 'MEDIA_NOT_READY', 'The upload is not ready or not yours');
  }

  /** Hourly: unattached private uploads and never-uploaded presigns older than 24 h are deleted (objects + soft delete). */
  async purgeStale(olderThanHours = 24): Promise<number> {
    const stale = await this.prisma.$queryRaw<Media[]>`
      SELECT * FROM media WHERE deleted_at IS NULL AND created_at < now() - make_interval(hours => ${olderThanHours}::int)
         AND (status = 'PENDING_UPLOAD' OR (visibility = 'PRIVATE' AND claimed_at IS NULL)) LIMIT 500`;
    for (const m of stale) {
      const bucket = this.cfg.buckets[m.visibility];
      for (const key of [m.key, ...Object.values((m.renditions ?? {}) as Record<string, string>)]) await this.cfg.store.delete(bucket, key).catch(() => {});
      await this.prisma.media.update({ where: { id: m.id }, data: { deletedAt: new Date() } });
    }
    return stale.length;
  }
}
