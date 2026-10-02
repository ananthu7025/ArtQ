// Object storage (Cloudflare R2 in production, S3Mock locally) behind a small interface the media service uses.
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type HeadResult = { size: number; contentType: string | null };

export interface ObjectStore {
  /** Presigned PUT whose signature covers Content-Type and Content-Length (architecture.md §9.1). */
  presignPut(bucket: string, key: string, o: { contentType: string; contentLength: number; expiresIn: number }): Promise<string>;
  presignGet(bucket: string, key: string, o: { expiresIn: number; attachmentName?: string }): Promise<string>;
  head(bucket: string, key: string): Promise<HeadResult | null>;
  /** Reads an object, refusing more than `maxBytes`. */
  get(bucket: string, key: string, maxBytes: number): Promise<Buffer>;
  put(bucket: string, key: string, body: Buffer, contentType: string, cacheControl?: string): Promise<void>;
  delete(bucket: string, key: string): Promise<void>;
}

export class ObjectTooLargeError extends Error {
  constructor(max: number) { super(`object larger than ${max} bytes`); this.name = 'ObjectTooLargeError'; }
}

export type S3Config = { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };

export class S3ObjectStore implements ObjectStore {
  readonly client: S3Client;
  constructor(c: S3Config) {
    this.client = new S3Client({
      endpoint: c.endpoint, region: c.region, forcePathStyle: c.forcePathStyle,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  presignPut(bucket: string, key: string, o: { contentType: string; contentLength: number; expiresIn: number }) {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: o.contentType, ContentLength: o.contentLength }), {
      expiresIn: o.expiresIn, signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  presignGet(bucket: string, key: string, o: { expiresIn: number; attachmentName?: string }) {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: bucket, Key: key, ResponseCacheControl: 'private, no-store',
      ...(o.attachmentName ? { ResponseContentDisposition: `attachment; filename="${o.attachmentName.replace(/[^\w.-]/g, '_')}"` } : {}),
    }), { expiresIn: o.expiresIn });
  }

  async head(bucket: string, key: string): Promise<HeadResult | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType ?? null };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (e as Error).name === 'NotFound' || (e as Error).name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async get(bucket: string, key: string, maxBytes: number): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (Number(r.ContentLength ?? 0) > maxBytes) throw new ObjectTooLargeError(maxBytes);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of r.Body as AsyncIterable<Uint8Array>) {
      size += c.length;
      if (size > maxBytes) throw new ObjectTooLargeError(maxBytes);
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }

  async put(bucket: string, key: string, body: Buffer, contentType: string, cacheControl?: string) {
    await this.client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ...(cacheControl ? { CacheControl: cacheControl } : {}) }));
  }

  async delete(bucket: string, key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
