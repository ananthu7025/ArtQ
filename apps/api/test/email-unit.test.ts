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
  order_placed: { orderNumber: 'AQ10234', firstName: 'Hema', paymentMethod: 'COD', lines: [{ name: 'Epoxy <Resin>', label: '500 ml', quantity: 2, total: 99_800 }],
    totals: { subtotal: 99_800, couponDiscount: 5000, couponCode: 'WELCOME10', shipping: 7000, codFee: 4000, total: 105_800 }, address: ['Hema R', '12 Rose Villa', 'Kochi, Kerala 682011'], estimate: '4–7 days', setPasswordLink: null },
  order_confirmed: { orderNumber: 'AQ1', firstName: 'Hema', estimate: '4–7 days' },
  order_delivered: { orderNumber: 'AQ1', firstName: 'Hema' },
  order_expired: { orderNumber: 'AQ1' },
  order_cancelled: { orderNumber: 'AQ1' },
  payment_refund_notice: { orderNumber: 'AQ1', reason: 'EXCESS', amount: 49_900 },
  refund_processed: { orderNumber: 'AQ1', amount: 49_900 },
  set_password_link: { link: 'https://artq.in/set-password?token=abc' },
  admin_order_placed: { orderNumber: 'AQ1', total: 49_900, paymentMethod: 'RAZORPAY', itemCount: 2, customer: 'Hema R, Kochi' },
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

  it('order placed: items, totals with coupon / shipping / COD fee, address, delivery days; COD asks to keep the amount ready; values escaped; the set-password link only when given', () => {
    const r = render('order_placed', DATA.order_placed!);
    expect(r.subject).toBe('Order AQ10234 placed');
    expect(r.text).toContain('2 × Epoxy <Resin> (500 ml): ₹998');
    expect(r.text).toContain('keep ₹1,058 ready');
    expect(r.html).toContain('Epoxy &lt;Resin&gt;');
    expect(r.html).toContain('−₹50');
    expect(r.html).toContain('Cash on delivery fee');
    expect(r.html).toContain('Kochi, Kerala 682011');
    expect(r.text).toContain('4–7 days');
    expect(r.html).not.toContain('Set a password');
    const withLink = render('order_placed', { ...DATA.order_placed!, paymentMethod: 'RAZORPAY', setPasswordLink: 'https://artq.in/set-password?token=t"x' });
    expect(withLink.text).toContain('Your payment is confirmed.');
    expect(withLink.html).toContain('href="https://artq.in/set-password?token=t&quot;x"');
    expect(() => render('order_placed', { ...DATA.order_placed!, lines: [] })).toThrow('lines');
  });
  it('confirmed / delivered: greet by name, name the order; missing data fails', () => {
    expect(render('order_confirmed', DATA.order_confirmed!)).toMatchObject({ subject: 'Order AQ1 confirmed', text: expect.stringContaining('We usually deliver in 4–7 days') });
    expect(render('order_delivered', DATA.order_delivered!)).toMatchObject({ subject: 'Order AQ1 delivered', text: expect.stringMatching(/^Hi Hema, your order AQ1 has been delivered/) });
    expect(() => render('order_confirmed', { orderNumber: 'AQ1', firstName: 'Hema' })).toThrow(/estimate/);
    expect(render('order_delivered', { orderNumber: 'AQ1', firstName: '<b>' }).html).toContain('&lt;b&gt;');
  });
  it('refund notice explains why (paid twice / arrived late)', () => {
    expect(render('payment_refund_notice', DATA.payment_refund_notice!).text).toMatch(/two payments for order AQ1\. The extra payment of ₹499/);
    expect(render('payment_refund_notice', { ...DATA.payment_refund_notice!, reason: 'LATE' }).text).toMatch(/arrived after the order had closed/);
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
