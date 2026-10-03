import { describe, expect, it } from 'vitest';
import { render, TEMPLATE_NAMES, UnknownTemplateError } from '../src/email/templates.js';
import { EmailSendError, MemoryTransport, ResendTransport } from '../src/email/transport.js';

const DATA: Record<string, Record<string, unknown>> = {
  otp: { code: '482913', purpose: 'LOGIN', expiresInMinutes: 10 },
  password_reset: { link: 'https://artq.in/reset-password?token=abc' },
  staff_invite: { link: 'https://admin.artq.in/reset-password?token=abc', role: 'ADMIN', name: 'Sanju' },
  password_changed: {},
  signup_attempt_existing: {},
  new_signin_activity: {},
  admin_payment_exception: { type: 'OUTBOX_DEAD', order_id: null },
  email_change_requested: { newEmail: 'n***@example.com' },
  email_changed: { newEmail: 'n***@example.com' },
  account_deleted: {},
};

describe('email templates', () => {
  it.each(TEMPLATE_NAMES)('%s renders subject, text and html', (name) => {
    const r = render(name, DATA[name]!);
    expect(r.subject.length).toBeGreaterThan(5);
    expect(r.text.length).toBeGreaterThan(10);
    expect(r.html).toMatch(/^<!doctype html>/);
  });

  it('every template has test data', () => { expect(Object.keys(DATA).sort()).toEqual([...TEMPLATE_NAMES].sort()); });

  it('OTP and reset emails carry the code / link; signup wording differs from login', () => {
    const otp = render('otp', DATA.otp!);
    expect(otp.subject).toBe('482913 is your ArtQ code');
    expect(otp.text).toContain('log in');
    expect(render('otp', { ...DATA.otp, purpose: 'SIGNUP_VERIFY' }).text).toContain('verify your email');
    expect(render('password_reset', DATA.password_reset!).html).toContain('href="https://artq.in/reset-password?token=abc"');
  });

  it('staff invite names the role and links to the admin app; an unknown role reads as Staff; a missing link throws', () => {
    const r = render('staff_invite', DATA.staff_invite!);
    expect(r.text).toContain('Admin access');
    expect(r.html).toContain('href="https://admin.artq.in/reset-password?token=abc"');
    expect(render('staff_invite', { ...DATA.staff_invite, role: 'CUSTOMER' }).text).toContain('Staff access');
    expect(() => render('staff_invite', { role: 'ADMIN' })).toThrow(/link/);
  });

  it('escapes interpolated values', () => {
    const r = render('admin_payment_exception', { type: '<script>alert(1)</script>', order_id: '"x"' });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('&quot;x&quot;');
    expect(render('password_reset', { link: 'https://artq.in/r?a=1&b="2"' }).html).toContain('href="https://artq.in/r?a=1&amp;b=&quot;2&quot;"');
  });

  it('email-change notices name the new address (escaped) and need it', () => {
    for (const t of ['email_change_requested', 'email_changed'] as const) {
      const r = render(t, { newEmail: '<b>@x.in' });
      expect(r.text).toContain('<b>@x.in');
      expect(r.html).toContain('&lt;b&gt;@x.in');
      expect(() => render(t, {})).toThrow();
    }
    expect(render('account_deleted', {}).text).toMatch(/30 days/);
  });

  it('missing data and unknown templates fail loudly', () => {
    expect(() => render('otp', {})).toThrow(/code/);
    expect(() => render('password_reset', {})).toThrow(/link/);
    expect(() => render('nope', {})).toThrow(UnknownTemplateError);
  });
});

describe('ResendTransport', () => {
  const email = { from: 'ArtQ <no-reply@artq.in>', to: 'a@x.in', subject: 'S', text: 'T', html: '<p>H</p>', idempotencyKey: 'artq-outbox-1-abc-7-1700000000' };
  const stub = (status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []) =>
    (async (url: string, init?: RequestInit) => { seen.push({ url, ...(init ? { init } : {}) }); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;

  it('POSTs /emails with the API key and Idempotency-Key, returns the provider id', async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const t = new ResendTransport({ apiKey: 're_test', baseUrl: 'https://resend.test', fetchImpl: stub(200, { id: 'msg_1' }, seen) });
    expect(await t.send(email)).toEqual({ messageId: 'msg_1' });
    expect(seen[0]!.url).toBe('https://resend.test/emails');
    const h = seen[0]!.init!.headers as Record<string, string>;
    expect(h).toMatchObject({ Authorization: 'Bearer re_test', 'Idempotency-Key': email.idempotencyKey, 'Content-Type': 'application/json' });
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual({ from: email.from, to: ['a@x.in'], subject: 'S', text: 'T', html: '<p>H</p>' });
  });

  it.each([
    [422, { name: 'validation_error', message: 'bad to' }, false],
    [409, { name: 'invalid_idempotent_request', message: 'payload differs' }, false],
    [401, { name: 'missing_api_key' }, false],
    [429, { name: 'rate_limit_exceeded' }, true],
    [500, { name: 'internal_server_error' }, true],
    [200, {}, false],                                  // accepted without an id is treated as an error
  ])('HTTP %i → EmailSendError (retryable %s)', async (status, body, retryable) => {
    const t = new ResendTransport({ apiKey: 'k', fetchImpl: stub(status, body) });
    const e = await t.send(email).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EmailSendError);
    expect((e as EmailSendError).retryable).toBe(retryable);
  });

  it('network errors and timeouts are retryable', async () => {
    const t = new ResendTransport({ apiKey: 'k', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    const e = await t.send(email).catch((x: unknown) => x);
    expect(e).toMatchObject({ retryable: true, message: expect.stringContaining('fetch failed') });
  });
});

describe('MemoryTransport', () => {
  it('records messages and can simulate failures', async () => {
    const t = new MemoryTransport();
    t.failNext = 1;
    await expect(t.send({ from: 'f', to: 'a@x.in', subject: 's', text: 't', html: 'h', idempotencyKey: 'k' })).rejects.toBeInstanceOf(EmailSendError);
    expect((await t.send({ from: 'f', to: 'a@x.in', subject: 's', text: 't', html: 'h', idempotencyKey: 'k' })).messageId).toBe('mem-1');
    expect(t.sent).toHaveLength(1);
  });
});
