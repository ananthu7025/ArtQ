// Smoke tests against the running docker-compose stack (task 0.3). Run with: pnpm test:compose
// (requires `docker compose up -d --wait`). Skipped unless COMPOSE_TESTS=1.
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { render } from '../../src/email/templates.js';
import { SmtpTransport } from '../../src/email/transport.js';
import sharp from 'sharp';
import { MediaService } from '../../src/media/service.js';
import { S3ObjectStore } from '../../src/media/storage.js';
import { createMigratedDatabase } from '../helpers/db.js';
import { makeReadinessChecks } from '../../src/lib/readiness.js';

const enabled = process.env.COMPOSE_TESTS === '1';
const root = join(import.meta.dirname, '..', '..', '..', '..');
const example = Object.fromEntries(readFileSync(join(root, '.env.example'), 'utf8').split('\n')
  .filter((l) => l.trim() && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"(.*)"$/, '$1')]));
const env = enabled ? loadEnv(example) : undefined;
const S3 = example.S3_ENDPOINT!;
const MAIL_UI = `http://localhost:${process.env.ARTQ_MAIL_UI_PORT ?? 8025}`;

const closers: (() => Promise<unknown> | void)[] = [];
afterAll(async () => { for (const c of closers) await c(); });

function smtpSend(port: number, from: string, to: string, subject: string): Promise<string[]> {
  // Minimal SMTP client: enough to prove Mailpit accepts mail on the configured port.
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const script = [`EHLO artq.test`, `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA', `Subject: ${subject}\r\nFrom: ${from}\r\nTo: ${to}\r\n\r\nhello from compose smoke\r\n.`, 'QUIT'];
    const sock = net.createConnection(port, '127.0.0.1');
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('SMTP timeout')); });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const done = buf.split('\r\n'); buf = done.pop()!;
      for (const l of done) { lines.push(l); if (/^\d{3} /.test(l) && script.length) sock.write(script.shift()! + '\r\n'); }
    });
    sock.on('end', () => resolve(lines));
    sock.on('error', reject);
  });
}

describe.skipIf(!enabled)('docker-compose stack', () => {
  describe('postgres', () => {
    const prisma = new PrismaClient({ datasourceUrl: env?.DATABASE_URL });
    closers.push(() => prisma.$disconnect());
    it('is PostgreSQL 16 with the artq database and required extensions available', async () => {
      const [{ server_version }] = await prisma.$queryRaw<{ server_version: string }[]>`SHOW server_version`;
      expect(server_version).toMatch(/^16\./);
      const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
      expect(db).toBe('artq');
      const ext = await prisma.$queryRaw<{ name: string }[]>`SELECT name FROM pg_available_extensions WHERE name IN ('citext','pg_trgm','unaccent') ORDER BY name`;
      expect(ext.map((e) => e.name)).toEqual(['citext', 'pg_trgm', 'unaccent']);
    });
    it('rejects a wrong password', async () => {
      const bad = new PrismaClient({ datasourceUrl: env!.DATABASE_URL.replace('artq:artq@', 'artq:wrong@') });
      await expect(bad.$queryRaw`SELECT 1`).rejects.toThrow();
      await bad.$disconnect();
    });
    it('is bound to localhost only', async () => {
      expect(new URL(env!.DATABASE_URL).hostname).toBe('localhost');
    });
  });

  describe('redis', () => {
    const redis = new Redis(env?.REDIS_URL ?? 'redis://localhost:1', { lazyConnect: true });
    redis.on('error', () => {});
    closers.push(() => redis.disconnect());
    it('is Redis 7 with AOF persistence enabled', async () => {
      await redis.connect();
      expect(await redis.ping()).toBe('PONG');
      expect((await redis.info('server')).match(/redis_version:(\S+)/)![1]).toMatch(/^7\./);
      expect(await redis.config('GET', 'appendonly')).toEqual(['appendonly', 'yes']);
    });
    it('round-trips a key with expiry', async () => {
      await redis.set('compose-smoke', 'ok', 'EX', 30);
      expect(await redis.get('compose-smoke')).toBe('ok');
      expect(await redis.ttl('compose-smoke')).toBeGreaterThan(0);
    });
  });

  describe('s3 (R2 stand-in)', () => {
    it('has both buckets', async () => {
      const xml = await (await fetch(`${S3}/`)).text();
      expect(xml).toContain('<Name>artq-public</Name>');
      expect(xml).toContain('<Name>artq-private</Name>');
    });
    it('stores and returns an object', async () => {
      const key = `smoke/${Date.now()}.txt`;
      expect((await fetch(`${S3}/artq-public/${key}`, { method: 'PUT', body: 'hello', headers: { 'Content-Type': 'text/plain' } })).status).toBe(200);
      const got = await fetch(`${S3}/artq-public/${key}`);
      expect(got.status).toBe(200);
      expect(await got.text()).toBe('hello');
    });
    it('returns 404 for a missing object and a missing bucket', async () => {
      expect((await fetch(`${S3}/artq-public/does-not-exist-${Date.now()}`)).status).toBe(404);
      expect((await fetch(`${S3}/no-such-bucket/x`)).status).toBe(404);
    });
  });

  describe('mailpit', () => {
    it('accepts mail over SMTP and exposes it in the API', async () => {
      const subject = `compose-smoke-${Date.now()}`;
      const lines = await smtpSend(Number(example.SMTP_PORT), 'orders@artq.test', 'buyer@example.com', subject);
      expect(lines.some((l) => l.startsWith('250') && /queued|ok/i.test(l))).toBe(true);
      const res = await (await fetch(`${MAIL_UI}/api/v1/search?query=${encodeURIComponent(`subject:${subject}`)}`)).json() as { messages: { Subject: string }[] };
      expect(res.messages.map((m) => m.Subject)).toContain(subject);
    });

    it('receives a rendered ArtQ email from the real SmtpTransport (task 1.8)', async () => {
      const code = String(Date.now()).slice(-6);
      const r = render('otp', { code, purpose: 'LOGIN', expiresInMinutes: 10 });
      const t = new SmtpTransport({ host: env!.SMTP_HOST, port: env!.SMTP_PORT });
      const { messageId } = await t.send({ from: env!.EMAIL_FROM, to: 'buyer@example.com', ...r, idempotencyKey: `artq-compose-${code}` });
      expect(messageId).toBeTruthy();
      const res = await (await fetch(`${MAIL_UI}/api/v1/search?query=${encodeURIComponent(`subject:"${r.subject}"`)}`)).json() as { messages: { ID: string; Subject: string; From: { Address: string } }[] };
      const msg = res.messages.find((m) => m.Subject === r.subject)!;
      expect(msg.From.Address).toBe('no-reply@artq.in');
      const full = await (await fetch(`${MAIL_UI}/api/v1/message/${msg.ID}`)).json() as { Text: string; HTML: string };
      expect(full.Text).toContain(code);
      expect(full.HTML).toContain('Your ArtQ code');
      await expect(new SmtpTransport({ host: '127.0.0.1', port: 1 }).send({ from: env!.EMAIL_FROM, to: 'a@x.in', ...r, idempotencyKey: 'k' })).rejects.toMatchObject({ name: 'EmailSendError', retryable: true });
    });
  });

  describe('media pipeline against real S3Mock (task 1.11)', () => {
    it('presigned PUT (type + length signed) → complete (HEAD) → processed renditions in the bucket → private presigned GET', async () => {
      const db = await createMigratedDatabase(env!.DATABASE_URL);
      closers.push(() => db.drop());
      const store = new S3ObjectStore({ endpoint: env!.S3_ENDPOINT, region: env!.S3_REGION, accessKeyId: env!.S3_ACCESS_KEY_ID, secretAccessKey: env!.S3_SECRET_ACCESS_KEY, forcePathStyle: env!.S3_FORCE_PATH_STYLE });
      const buckets = { PUBLIC: env!.S3_BUCKET_PUBLIC, PRIVATE: env!.S3_BUCKET_PRIVATE };
      const media = new MediaService(db.prisma, { store, buckets, publicBaseUrl: env!.MEDIA_PUBLIC_BASE_URL }, async () => {});
      const png = await sharp({ create: { width: 500, height: 200, channels: 3, background: '#00756f' } }).png().toBuffer();
      const user = await db.prisma.user.create({ data: { email: 'media-admin@artq.in', role: 'ADMIN', status: 'ACTIVE' } });
      const actor = { userId: user.id, audience: 'admin' as const, role: 'ADMIN' as const };

      const p = await media.presign({ filename: 'frame.png', contentType: 'image/png', size: png.length, purpose: 'product-image' }, actor);
      expect(new URL(p.upload.url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
      const put = await fetch(p.upload.url, { method: 'PUT', headers: p.upload.headers, body: png });
      expect(put.status).toBe(200);
      expect((await media.complete(p.media.id, actor)).status).toBe('UPLOADED');
      expect(await media.process(p.media.id)).toBe('READY');
      const m = await db.prisma.media.findUniqueOrThrow({ where: { id: p.media.id } });
      for (const key of Object.values(m.renditions as Record<string, string>)) expect(await store.head(buckets.PUBLIC, key)).toMatchObject({ contentType: 'image/webp' });
      const publicUrl = media.view(m).renditions['160']!;
      expect((await fetch(publicUrl)).status).toBe(200);

      const x = await media.presign({ filename: 'import.png', contentType: 'image/png', size: png.length, purpose: 'cms-image' }, actor);
      await fetch(x.upload.url, { method: 'PUT', headers: x.upload.headers, body: png });
      const priv = await db.prisma.media.update({ where: { id: x.media.id }, data: { visibility: 'PRIVATE' } });
      await store.put(buckets.PRIVATE, priv.key, png, 'image/png');
      const url = await store.presignGet(buckets.PRIVATE, priv.key, { expiresIn: 60, attachmentName: 'a.png' });
      const got = await fetch(url);
      expect(got.status).toBe(200);
      expect(Buffer.from(await got.arrayBuffer()).equals(png)).toBe(true);
      expect(await store.head(buckets.PRIVATE, 'no/such/key')).toBeNull();
    }, 60_000);
  });

  describe('API readiness with .env.example', () => {
    it('is ready against the compose stack', async () => {
      const prisma = new PrismaClient({ datasourceUrl: env!.DATABASE_URL });
      const redis = new Redis(env!.REDIS_URL, { lazyConnect: true });
      closers.push(() => prisma.$disconnect(), () => redis.disconnect());
      const app = createApp({ version: 'compose', origins: { storefront: env!.STOREFRONT_ORIGINS, admin: env!.ADMIN_ORIGINS }, readiness: makeReadinessChecks(prisma, redis) });
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.checks).toEqual({ database: { ok: true }, redis: { ok: true } });
    });
  });
});
