// Builds the media service from the environment (shared by the API server and the worker).
import type { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.js';
import { MediaService } from './service.js';
import { S3ObjectStore } from './storage.js';

/** The object store and buckets from the environment (also used directly for server-made files such as invoices). */
export function mediaStorageFromEnv(env: Env) {
  const store = new S3ObjectStore({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, forcePathStyle: env.S3_FORCE_PATH_STYLE });
  return { store, buckets: { PUBLIC: env.S3_BUCKET_PUBLIC, PRIVATE: env.S3_BUCKET_PRIVATE } };
}

export function mediaServiceFromEnv(env: Env, prisma: PrismaClient, enqueue: (mediaId: number) => Promise<void>): MediaService {
  return new MediaService(prisma, { ...mediaStorageFromEnv(env), publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL }, enqueue);
}
