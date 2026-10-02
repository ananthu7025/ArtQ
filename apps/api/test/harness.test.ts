// Guards the test-harness fix in test/helpers/setup.ts (supertest must not reach 127.0.0.1 ports owned by other programs).
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

describe('test harness', () => {
  it('supertest reaches its own wildcard server over IPv6 loopback', async () => {
    const app = express().get('/ping', (_req, res) => { res.send('pong'); });
    const t = request(app).get('/ping');
    expect(t.url).toMatch(/^http:\/\/\[::1\]:\d+\/ping$/);
    expect((await t).text).toBe('pong');
  });
});
