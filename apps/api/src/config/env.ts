import { z } from 'zod';

function isBareOrigin(u: string): boolean {
  try { return new URL(u).origin === u.replace(/\/$/, ''); } catch { return false; }
}
const origin = z.string().refine(isBareOrigin, 'must be an origin (scheme://host[:port])');
const origins = z.string().min(1).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(origin).min(1));

// Validated at boot: a missing or malformed variable stops the process with a clear message (task 0.4).
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_VERSION: z.string().min(1).default('dev'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url().refine((u) => u.startsWith('postgresql://') || u.startsWith('postgres://'), 'must be a postgresql:// URL'),
  REDIS_URL: z.string().url().refine((u) => u.startsWith('redis://') || u.startsWith('rediss://'), 'must be a redis:// URL'),
  /** Exact storefront origins allowed to call the API (architecture.md §5.5), comma-separated. */
  STOREFRONT_ORIGINS: origins,
  /** Exact admin SPA origins; only these may call `/v1/admin/*`. */
  ADMIN_ORIGINS: origins,
  // Auth (architecture.md §5.1): one set per environment, never shared between environments.
  AUTH_JWT_SECRET: z.string().min(32),
  AUTH_JWT_ISSUER: z.string().min(1).optional(),
  AUTH_OTP_PEPPER: z.string().min(16),
  AUTH_LINK_SECRET: z.string().min(32),
  /** Storefront origin used in emailed links. */
  WEB_URL: origin,
  // Email (task 1.8): smtp for local Mailpit / tests; resend (idempotency keys) for staging and production.
  EMAIL_TRANSPORT: z.enum(['smtp', 'resend']).default('smtp'),
  EMAIL_FROM: z.string().min(3).default('ArtQ <no-reply@artq.in>'),
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  RESEND_API_KEY: z.string().optional(),
  /** Razorpay webhook secret; without it POST /v1/webhooks/razorpay answers 503 (Razorpay retries). Required from Phase 4. */
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Object storage (task 1.11): Cloudflare R2 in production, S3Mock locally.
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1).default('auto'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_PUBLIC: z.string().min(3),
  S3_BUCKET_PRIVATE: z.string().min(3),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Base URL of public renditions (the CDN in production); defaults to <S3_ENDPOINT>/<S3_BUCKET_PUBLIC>. */
  MEDIA_PUBLIC_BASE_URL: z.url().optional(),
});
export type Env = z.infer<typeof envSchema> & { AUTH_JWT_ISSUER: string; MEDIA_PUBLIC_BASE_URL: string };

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = envSchema.safeParse(source);
  if (!r.success) throw new ConfigError(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  const issues: string[] = [];
  for (const k of ['STOREFRONT_ORIGINS', 'ADMIN_ORIGINS'] as const) {
    if (r.data.NODE_ENV === 'production' && r.data[k].some((o) => !o.startsWith('https://'))) issues.push(`${k}: production origins must use https://`);
  }
  if (r.data.STOREFRONT_ORIGINS.some((o) => r.data.ADMIN_ORIGINS.includes(o))) issues.push('ADMIN_ORIGINS: must not overlap STOREFRONT_ORIGINS');
  if (r.data.AUTH_JWT_SECRET === r.data.AUTH_LINK_SECRET) issues.push('AUTH_LINK_SECRET: must differ from AUTH_JWT_SECRET');
  if (r.data.NODE_ENV === 'production' || r.data.NODE_ENV === 'staging') {
    for (const k of ['AUTH_JWT_SECRET', 'AUTH_OTP_PEPPER', 'AUTH_LINK_SECRET'] as const) {
      if (r.data[k].startsWith('dev-insecure')) issues.push(`${k}: the development placeholder cannot be used in ${r.data.NODE_ENV}`);
    }
    if (!r.data.WEB_URL.startsWith('https://')) issues.push('WEB_URL: must use https://');
  }
  if (r.data.EMAIL_TRANSPORT === 'resend' && !r.data.RESEND_API_KEY) issues.push('RESEND_API_KEY: required when EMAIL_TRANSPORT=resend');
  if (r.data.NODE_ENV === 'production' && r.data.EMAIL_TRANSPORT !== 'resend') {
    issues.push('EMAIL_TRANSPORT: production must use a provider with idempotency keys (resend)');
  }
  if (r.data.S3_BUCKET_PUBLIC === r.data.S3_BUCKET_PRIVATE) issues.push('S3_BUCKET_PRIVATE: must differ from S3_BUCKET_PUBLIC');
  if (r.data.NODE_ENV === 'production' && !r.data.S3_ENDPOINT.startsWith('https://')) issues.push('S3_ENDPOINT: production must use https://');
  if (issues.length) throw new ConfigError(issues);
  return { ...r.data, AUTH_JWT_ISSUER: r.data.AUTH_JWT_ISSUER ?? `artq-${r.data.NODE_ENV}`, MEDIA_PUBLIC_BASE_URL: r.data.MEDIA_PUBLIC_BASE_URL ?? `${r.data.S3_ENDPOINT.replace(/\/$/, '')}/${r.data.S3_BUCKET_PUBLIC}` };
}
