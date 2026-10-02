// CLAUDE.md "Validation rule": every endpoint validates with the SAME schema object the forms import from @artq/shared,
// so the two can never drift apart.
import * as shared from '@artq/shared';
import { describe, expect, it } from 'vitest';
import { staffSchemas } from '../src/admin/staff-routes.js';
import { adminAuthSchemas } from '../src/auth/admin-routes.js';
import { schemas as storefrontAuth } from '../src/auth/routes.js';
import { PASSWORD_MAX, STAFF_PASSWORD_MIN } from '../src/lib/password.js';

describe('API request schemas are the shared ones', () => {
  it('admin auth', () => {
    expect(adminAuthSchemas.login).toBe(shared.adminLoginBody);
    expect(adminAuthSchemas.stepUp).toBe(shared.stepUpBody);
    expect(adminAuthSchemas.forgot).toBe(shared.adminForgotPasswordBody);
    expect(adminAuthSchemas.reset).toBe(shared.adminResetPasswordBody);
  });

  it('storefront auth', () => {
    expect(storefrontAuth).toEqual({
      signup: shared.signupBody, verify: shared.signupVerifyBody, login: shared.loginBody, otpRequest: shared.otpRequestBody,
      otpVerify: shared.otpVerifyBody, empty: shared.emptyBody, forgot: shared.forgotPasswordBody, reset: shared.resetPasswordBody,
    });
    for (const [k, v] of Object.entries(storefrontAuth)) expect(v, k).toBe(Object.values(shared).find((s) => s === v));
  });

  it('staff', () => {
    expect(staffSchemas.create).toBe(shared.staffCreateBody);
    expect(staffSchemas.update).toBe(shared.staffUpdateBody);
    expect(staffSchemas.list).toBe(shared.staffListQuery);
  });

  it('password limits used by the service are the shared constants', () => {
    expect([STAFF_PASSWORD_MIN, PASSWORD_MAX]).toEqual([shared.STAFF_PASSWORD_MIN, shared.PASSWORD_MAX]);
  });
});
