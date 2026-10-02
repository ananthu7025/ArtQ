// Images that catalogue records may point at: this admin pipeline's PUBLIC images that were uploaded (processing or
// ready). Failed, rejected, never-uploaded, private, import and video media are refused (api.md §4.3/§4.4).
import { AppError } from '../lib/errors.js';
import type { Db } from '../db/functions.js';

export async function assertUsableImages(db: Db, mediaIds: number[]): Promise<void> {
  const ids = [...new Set(mediaIds)];
  if (ids.length === 0) return;
  const ok = await db.media.findMany({
    where: { id: { in: ids }, kind: 'IMAGE', visibility: 'PUBLIC', ownerScope: 'admin', deletedAt: null, status: { in: ['UPLOADED', 'PROCESSING', 'READY'] } },
    select: { id: true },
  });
  const missing = ids.filter((m) => !ok.some((o) => o.id === m));
  if (missing.length) throw new AppError(422, 'MEDIA_NOT_USABLE', 'Some images are missing, failed or are not product images', { mediaIds: missing });
  // Attached media are kept by the stale-upload purge.
  await db.media.updateMany({ where: { id: { in: ids }, claimedAt: null }, data: { claimedAt: new Date() } });
}
