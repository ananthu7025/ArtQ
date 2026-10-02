// In-memory ObjectStore for tests without S3 (the compose suite uses the real S3Mock).
import { ObjectTooLargeError, type HeadResult, type ObjectStore } from '../../src/media/storage.js';

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string; cacheControl?: string }>();
  failGets = 0;
  private k = (bucket: string, key: string) => `${bucket}/${key}`;

  /** Simulates the browser's direct upload to the presigned URL. */
  upload(bucket: string, key: string, body: Buffer, contentType: string) { this.objects.set(this.k(bucket, key), { body, contentType }); }

  async presignPut(bucket: string, key: string, o: { contentType: string; contentLength: number; expiresIn: number }) {
    return `memory://${bucket}/${key}?put&type=${encodeURIComponent(o.contentType)}&len=${o.contentLength}&exp=${o.expiresIn}`;
  }
  async presignGet(bucket: string, key: string, o: { expiresIn: number; attachmentName?: string }) {
    return `https://storage.test/${bucket}/${key}?exp=${o.expiresIn}${o.attachmentName ? `&download=${encodeURIComponent(o.attachmentName)}` : ''}`;
  }
  async head(bucket: string, key: string): Promise<HeadResult | null> {
    const o = this.objects.get(this.k(bucket, key));
    return o ? { size: o.body.length, contentType: o.contentType } : null;
  }
  async get(bucket: string, key: string, maxBytes: number) {
    if (this.failGets > 0) { this.failGets--; throw new Error('simulated storage outage'); }
    const o = this.objects.get(this.k(bucket, key));
    if (!o) throw new Error('NoSuchKey');
    if (o.body.length > maxBytes) throw new ObjectTooLargeError(maxBytes);
    return o.body;
  }
  async put(bucket: string, key: string, body: Buffer, contentType: string, cacheControl?: string) {
    this.objects.set(this.k(bucket, key), { body, contentType, ...(cacheControl ? { cacheControl } : {}) });
  }
  async delete(bucket: string, key: string) { this.objects.delete(this.k(bucket, key)); }
}
