// Task 4.2: the account request bodies, used unchanged by the API and the storefront forms (validation rule).
import { describe, expect, it } from 'vitest';
import {
  addressBody, changePasswordBody, deleteAccountBody, emailChangeBody, emailVerifyBody, profileBody, WISHLIST_MAX, wishlistMergeBody, wishlistToggleBody,
} from './auth-schemas.js';

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));

describe('profileBody', () => {
  it('trims the name; an empty phone clears it; name 120 passes, 121 fails; unknown keys refused', () => {
    expect(profileBody.parse({ name: ' Asha ', phone: '' })).toEqual({ name: 'Asha', phone: null });
    expect(profileBody.parse({ name: 'A', phone: null, marketingOptIn: false })).toEqual({ name: 'A', phone: null, marketingOptIn: false });
    expect(profileBody.safeParse({ name: 'x'.repeat(120) }).success).toBe(true);
    expect(issues(profileBody.safeParse({ name: 'x'.repeat(121) }))).toHaveProperty('name');
    expect(issues(profileBody.safeParse({ name: ' ' }))).toHaveProperty('name');
    expect(issues(profileBody.safeParse({ name: 'A', phone: '12' }))).toHaveProperty('phone');
    expect(profileBody.safeParse({ name: 'A', email: 'a@b.in' }).success).toBe(false);
  });
});

describe('changePasswordBody', () => {
  it('needs the current password; the new one 8+ characters and different', () => {
    expect(changePasswordBody.safeParse({ currentPassword: 'old-pass-1', newPassword: 'new-pass-1' }).success).toBe(true);
    expect(issues(changePasswordBody.safeParse({ currentPassword: 'same-pass-1', newPassword: 'same-pass-1' }))).toEqual({ newPassword: 'Choose a password different from the current one' });
    expect(issues(changePasswordBody.safeParse({ currentPassword: '', newPassword: 'short1' }))).toHaveProperty('newPassword');
    expect(issues(changePasswordBody.safeParse({ currentPassword: '', newPassword: 'long-enough-1' }))).toHaveProperty('currentPassword');
  });
});

describe('email change', () => {
  it('a valid new address and the password; the code is 6 digits', () => {
    expect(emailChangeBody.parse({ newEmail: ' A@B.in ', password: 'p' }).newEmail).toMatch(/a@b\.in/i);
    expect(issues(emailChangeBody.safeParse({ newEmail: 'nope', password: 'p' }))).toHaveProperty('newEmail');
    expect(emailVerifyBody.safeParse({ code: '123456' }).success).toBe(true);
    for (const code of ['12345', '1234567', 'abcdef']) expect(emailVerifyBody.safeParse({ code }).success).toBe(false);
  });
});

describe('deleteAccountBody', () => {
  it('the box must be ticked (true only)', () => {
    expect(deleteAccountBody.safeParse({ password: 'p', confirm: true }).success).toBe(true);
    expect(issues(deleteAccountBody.safeParse({ password: 'p', confirm: false }))).toEqual({ confirm: 'Tick the box to confirm' });
    expect(issues(deleteAccountBody.safeParse({ password: 'p' }))).toEqual({ confirm: 'Tick the box to confirm' });
  });
});

describe('addressBody', () => {
  const ok = { fullName: 'Asha', phone: '+919847012345', line1: '12 MG Road', city: 'Kochi', stateId: 1, pincode: '682011' };
  it('defaults the label to HOME; trims; empty optional lines dropped', () => {
    const a = addressBody.parse({ ...ok, line2: '  ', landmark: ' Park ' });
    expect(a).toMatchObject({ label: 'HOME', landmark: 'Park' });
    expect(a.line2 ?? null).toBeNull();
  });
  it.each([['682011', true], ['000000', false], ['68201', false], ['6820111', false], ['68201a', false]])('pincode %s → %s', (pincode, valid) => {
    expect(addressBody.safeParse({ ...ok, pincode }).success).toBe(valid);
  });
  it('limits at the boundary: name 120 / line1 200 / city 80 pass, one more fails', () => {
    for (const [k, n] of [['fullName', 120], ['line1', 200], ['city', 80], ['line2', 200], ['landmark', 120]] as const) {
      expect(addressBody.safeParse({ ...ok, [k]: 'x'.repeat(n) }).success, k).toBe(true);
      expect(issues(addressBody.safeParse({ ...ok, [k]: 'x'.repeat(n + 1) })), k).toHaveProperty(k);
    }
  });
  it('missing state → "Choose a state"; unknown label and keys refused', () => {
    expect(issues(addressBody.safeParse({ ...ok, stateId: undefined }))).toEqual({ stateId: 'Choose a state' });
    expect(addressBody.safeParse({ ...ok, label: 'PARENTS' }).success).toBe(false);
    expect(addressBody.safeParse({ ...ok, userId: 2 }).success).toBe(false);
  });
});

describe('wishlist bodies', () => {
  it('positive product ids; merge takes at most 100', () => {
    expect(wishlistToggleBody.safeParse({ productId: 1 }).success).toBe(true);
    expect(wishlistToggleBody.safeParse({ productId: 0 }).success).toBe(false);
    expect(wishlistMergeBody.safeParse({ productIds: [] }).success).toBe(true);
    expect(wishlistMergeBody.safeParse({ productIds: Array.from({ length: WISHLIST_MAX }, (_, i) => i + 1) }).success).toBe(true);
    expect(wishlistMergeBody.safeParse({ productIds: Array.from({ length: WISHLIST_MAX + 1 }, (_, i) => i + 1) }).success).toBe(false);
  });
});
