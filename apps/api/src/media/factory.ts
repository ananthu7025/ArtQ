// Builds the media service from the environment (shared by the API server and the worker).
import type { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.js';
import { MediaService } from './service.js';
import { S3ObjectStore } from './storage.js';

export function mediaServiceFromEnv(env: Env, prisma: PrismaClient, enqueue: (mediaId: number) => Promise<void>): MediaService {
  const store = new S3ObjectStore({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, forcePathStyle: env.S3_FORCE_PATH_STYLE });
  return new MediaService(prisma, { store, buckets: { PUBLIC: env.S3_BUCKET_PUBLIC, PRIVATE: env.S3_BUCKET_PRIVATE }, publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL }, enqueue);
}
