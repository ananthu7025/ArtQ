import { describe, expect, it } from 'vitest';
import { redisConnection } from '../src/lib/redis-url.js';

describe('redisConnection', () => {
  it.each([
    ['redis://localhost:56379', { host: 'localhost', port: 56379, db: 0 }],
    ['redis://localhost:56379/5', { host: 'localhost', port: 56379, db: 5 }],
    ['redis://localhost', { host: 'localhost', port: 6379, db: 0 }],
    ['redis://:p%40ss@cache.internal:6380/2', { host: 'cache.internal', port: 6380, db: 2, password: 'p@ss' }],
    ['redis://default:secret@cache.internal:6379', { host: 'cache.internal', port: 6379, db: 0, username: 'default', password: 'secret' }],
    ['rediss://user:pw@managed.example:6380/1', { host: 'managed.example', port: 6380, db: 1, username: 'user', password: 'pw', tls: {} }],
    ['redis://[::1]:6379/3', { host: '::1', port: 6379, db: 3 }],
  ])('%s', (url, expected) => {
    expect(redisConnection(url)).toEqual({ ...expected, maxRetriesPerRequest: null });
  });

  it.each(['http://localhost:6379', 'redis://localhost/abc', 'redis://localhost/16', 'redis://localhost/-1'])('rejects %s', (url) => {
    expect(() => redisConnection(url)).toThrow(TypeError);
  });
});
