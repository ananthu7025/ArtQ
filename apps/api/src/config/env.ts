import { z } from 'zod';

function isBareOrigin(u: string): boolean {
  try { return new URL(u).origin === u.replace(/\/$/, ''); } catch { return false; }
}
const origin = z.string().refine(isBareOrigin, 'must be an origin (scheme://host[:port])');

// Validated at boot: a missing or malformed variable stops the process with a clear message (task 0.4).
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_VERSION: z.string().min(1).default('dev'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url().refine((u) => u.startsWith('postgresql://') || u.startsWith('postgres://'), 'must be a postgresql:// URL'),
  REDIS_URL: z.string().url().refine((u) => u.startsWith('redis://') || u.startsWith('rediss://'), 'must be a redis:// URL'),
  CORS_ORIGINS: z.string().min(1).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(origin).min(1)),
  // Auth (architecture.md §5.1): one set per environment, never shared between environments.
  AUTH_JWT_SECRET: z.string().min(32),
  AUTH_JWT_ISSUER: z.string().min(1).optional(),
  AUTH_OTP_PEPPER: z.string().min(16),
  AUTH_LINK_SECRET: z.string().min(32),
  /** Storefront origin used in emailed links. */
  WEB_URL: origin,
});
export type Env = z.infer<typeof envSchema> & { AUTH_JWT_ISSUER: string };

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
  if (r.data.NODE_ENV === 'production' && r.data.CORS_ORIGINS.some((o) => !o.startsWith('https://'))) {
    issues.push('CORS_ORIGINS: production origins must use https://');
  }
  if (r.data.AUTH_JWT_SECRET === r.data.AUTH_LINK_SECRET) issues.push('AUTH_LINK_SECRET: must differ from AUTH_JWT_SECRET');
  if (r.data.NODE_ENV === 'production' || r.data.NODE_ENV === 'staging') {
    for (const k of ['AUTH_JWT_SECRET', 'AUTH_OTP_PEPPER', 'AUTH_LINK_SECRET'] as const) {
      if (r.data[k].startsWith('dev-insecure')) issues.push(`${k}: the development placeholder cannot be used in ${r.data.NODE_ENV}`);
    }
    if (!r.data.WEB_URL.startsWith('https://')) issues.push('WEB_URL: must use https://');
  }
  if (issues.length) throw new ConfigError(issues);
  return { ...r.data, AUTH_JWT_ISSUER: r.data.AUTH_JWT_ISSUER ?? `artq-${r.data.NODE_ENV}` };
}
