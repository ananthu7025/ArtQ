import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { envSchema, loadEnv } from '../src/config/env.js';

// Structural checks of the local infrastructure files (task 0.3). They do not start Docker.
const root = join(import.meta.dirname, '..', '..', '..');
const compose = parse(readFileSync(join(root, 'docker-compose.yml'), 'utf8')) as { services: Record<string, { image: string; command?: string[]; environment?: Record<string, string>; ports?: string[] }> };
const exampleEnv = Object.fromEntries(readFileSync(join(root, '.env.example'), 'utf8').split('\n')
  .filter((l) => l.trim() && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

describe('docker-compose.yml', () => {
  it('defines the four local services', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['mailpit', 'postgres', 'redis', 's3']);
  });
  it('pins every image to an explicit tag (no latest, no untagged)', () => {
    for (const [name, s] of Object.entries(compose.services)) {
      expect(s.image, name).toMatch(/:[^:]+$/);
      expect(s.image, name).not.toMatch(/:latest$/);
    }
  });
  it('uses PostgreSQL 16 (deployment major) and Redis 7 with AOF', () => {
    expect(compose.services.postgres!.image).toMatch(/^postgres:16\./);
    expect(compose.services.redis!.image).toMatch(/^redis:7\./);
    expect(compose.services.redis!.command).toContain('--appendonly');
  });
  it('creates both object-storage buckets', () => {
    expect(compose.services.s3!.environment!.COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS!.split(',').sort()).toEqual(['artq-private', 'artq-public']);
  });
});

describe('.env.example', () => {
  it('contains every API environment variable', () => {
    for (const key of Object.keys(envSchema.shape)) expect(exampleEnv, key).toHaveProperty(key);
  });
  it('is a valid API configuration as-is', () => {
    expect(() => loadEnv(exampleEnv)).not.toThrow();
  });
  it('points the API at the compose services', () => {
    expect(exampleEnv.DATABASE_URL).toContain('localhost:5432');
    expect(exampleEnv.REDIS_URL).toBe('redis://localhost:6379');
    expect(exampleEnv.S3_ENDPOINT).toBe('http://localhost:9090');
  });
});
