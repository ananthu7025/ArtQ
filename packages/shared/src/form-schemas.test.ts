// Shared request schemas (CLAUDE.md "Validation rule"): the limits the API and the forms both enforce, at the boundaries.
import { describe, expect, it } from 'vitest';
import {
  adminLoginBody, adminResetPasswordBody, CUSTOMER_PASSWORD_MIN, emailField, EMAIL_MAX, NAME_MAX, PASSWORD_MAX, resetPasswordBody,
  signupBody, staffCreateBody, staffUpdateBody, STAFF_PASSWORD_MIN, stepUpBody,
} from './index.js';

const messages = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
const emailOf = (len: number) => `${'a'.repeat(len - '@artq.in'.length)}@artq.in`;

describe('email', () => {
  it('trims, accepts exactly 160 characters, refuses 161, empty and malformed with field messages', () => {
    expect(emailField.parse('  asha@artq.in ')).toBe('asha@artq.in');
    expect(emailField.safeParse(emailOf(EMAIL_MAX)).success).toBe(true);
    expect(messages(emailField.safeParse(emailOf(EMAIL_MAX + 1)))).toEqual([': Use at most 160 characters']);
    expect(messages(emailField.safeParse('   '))).toEqual([': Enter your email address']);
    expect(messages(emailField.safeParse('asha@'))).toEqual([': Enter a valid email address']);
  });
});

describe('passwords', () => {
  it.each([
    ['staff reset', (p: string) => adminResetPasswordBody.safeParse({ token: 't'.repeat(43), password: p }), STAFF_PASSWORD_MIN],
    ['customer reset', (p: string) => resetPasswordBody.safeParse({ token: 't'.repeat(43), password: p }), CUSTOMER_PASSWORD_MIN],
  ])('%s: exactly min and 128 pass; one less / one more fail', (_l, parse, min) => {
    const pw = (n: number) => `${'p'.repeat(n - 1)}1`;
    expect(parse(pw(min)).success).toBe(true);
    expect(parse(pw(PASSWORD_MAX)).success).toBe(true);
    expect(messages(parse(pw(min - 1)))).toEqual([`password: Use at least ${min} characters`]);
    expect(messages(parse(pw(PASSWORD_MAX + 1)))).toEqual([`password: Use at most ${PASSWORD_MAX} characters`]);
  });

  it('a new customer password needs a letter and a number (product.md §5.9); login does not', () => {
    const reset = (p: string) => resetPasswordBody.safeParse({ token: 't'.repeat(43), password: p });
    for (const ok of ['abcdefg1', '1234567a', 'ಕನ್ನಡ1234']) expect(reset(ok).success, ok).toBe(true);
    for (const bad of ['abcdefgh', '12345678', '--------']) expect(messages(reset(bad)), bad).toEqual(['password: Use at least one letter and one number']);
    expect(adminLoginBody.safeParse({ email: 'a@artq.in', password: 'abcdefgh' }).success).toBe(true);
  });

  it('login and step-up accept any non-empty password up to 128 (no minimum: old passwords still log in)', () => {
    expect(adminLoginBody.safeParse({ email: 'a@artq.in', password: 'x' }).success).toBe(true);
    expect(messages(adminLoginBody.safeParse({ email: 'a@artq.in', password: '' }))).toEqual(['password: Enter your password']);
    expect(stepUpBody.safeParse({ password: 'p'.repeat(PASSWORD_MAX + 1) }).success).toBe(false);
  });
});

describe('staff', () => {
  it('name 1–120 trimmed, staff roles only, unknown keys refused', () => {
    const base = { email: 'a@artq.in', role: 'STAFF' };
    expect(staffCreateBody.safeParse({ ...base, name: 'n'.repeat(NAME_MAX) }).success).toBe(true);
    expect(messages(staffCreateBody.safeParse({ ...base, name: 'n'.repeat(NAME_MAX + 1) }))).toEqual(['name: Use at most 120 characters']);
    expect(messages(staffCreateBody.safeParse({ ...base, name: '  ' }))).toEqual(['name: Enter a name']);
    expect(messages(staffCreateBody.safeParse({ ...base, name: 'A', role: 'CUSTOMER' }))).toEqual(['role: Choose a role']);
    expect(staffCreateBody.safeParse({ ...base, name: 'A', password: 'x' }).success).toBe(false);
    expect(staffUpdateBody.safeParse({ role: 'CUSTOMER' }).success).toBe(true);
    expect(messages(staffUpdateBody.safeParse({}))).toEqual([': Nothing to update']);
  });

  it('signup reuses the same name/email/password fields', () => {
    expect(signupBody.safeParse({ name: 'A', email: emailOf(EMAIL_MAX), password: `${'p'.repeat(CUSTOMER_PASSWORD_MIN - 1)}1` }).success).toBe(true);
    expect(signupBody.safeParse({ name: 'A', email: emailOf(EMAIL_MAX + 1), password: `${'p'.repeat(CUSTOMER_PASSWORD_MIN - 1)}1` }).success).toBe(false);
  });
});
