// ✅ AT-21 (task 7.1): a role change and a block while the person has live storefront and admin sessions. Real auth,
// staff and session routes on PostgreSQL + Redis. Pass: role change → the admin session is 401 on its next request and
// the storefront session keeps working; block → both 401 (C13 at database level).
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_ORIGIN, createAcceptanceApp, WEB, type AcceptanceApp } from '../helpers/acceptance-app.js';

let t: AcceptanceApp;
beforeAll(async () => { t = await createAcceptanceApp(); }, 180_000);
afterAll(async () => { await t?.close(); });
beforeEach(() => t.reset());

const storefront = (token: string) => request(t.app).get('/v1/me').set('Origin', WEB).set('Authorization', `Bearer ${token}`);
const adminMe = (token: string) => request(t.app).get('/v1/admin/me').set('Origin', ADMIN_ORIGIN).set('Authorization', `Bearer ${token}`);
const owner = (method: 'patch' | 'post', path: string, body: object = {}) => request(t.app)[method](`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN).set('Authorization', `Bearer ${t.ownerToken}`).send(body);

async function staffWithBothSessions() {
  const person = await t.customer({ role: 'ADMIN' });          // signed in to the shop
  const adminToken = await t.adminLogin(person.email);         // and to the admin
  expect((await storefront(person.token)).status).toBe(200);
  expect((await adminMe(adminToken)).status).toBe(200);
  return { ...person, adminToken };
}

describe('AT-21: access changes reach live sessions', () => {
  it('a role change ends the admin session at its next request; the storefront session keeps working', async () => {
    const p = await staffWithBothSessions();
    const changed = await owner('patch', `/staff/${p.id}`, { role: 'STAFF' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const next = await adminMe(p.adminToken);
    expect([next.status, next.body.error?.code]).toEqual([401, 'SESSION_INVALID']);
    expect((await storefront(p.token)).status).toBe(200);
    // Signing in again gives the new role's permissions.
    const fresh = await t.adminLogin(p.email);
    const me = await adminMe(fresh);
    expect(me.body.user.role).toBe('STAFF');
    expect(me.body.permissions).not.toContain('pricing:write');
  });

  it('removing admin access entirely (role CUSTOMER) ends the admin session; the shop session stays', async () => {
    const p = await staffWithBothSessions();
    expect((await owner('patch', `/staff/${p.id}`, { role: 'CUSTOMER' })).status).toBe(204);
    expect((await adminMe(p.adminToken)).status).toBe(401);
    expect((await storefront(p.token)).status).toBe(200);
    expect((await request(t.app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: p.email, password: 'acceptance-pass-1' })).status).toBe(401);
  });

  it('a block ends both sessions at their next request, and neither sign-in works', async () => {
    const p = await staffWithBothSessions();
    expect((await owner('post', `/staff/${p.id}/block`)).status).toBe(200);
    expect((await adminMe(p.adminToken)).status).toBe(401);
    expect((await storefront(p.token)).status).toBe(401);
    const shop = await request(t.app).post('/v1/auth/login').set('Origin', WEB).send({ email: p.email, password: 'acceptance-pass-1' });
    const staff = await request(t.app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: p.email, password: 'acceptance-pass-1' });
    expect([shop.status, shop.body.error?.code]).toEqual([403, 'ACCOUNT_BLOCKED']);
    expect([staff.status, staff.body.error?.code]).toEqual([403, 'ACCOUNT_BLOCKED']);
  });
});
