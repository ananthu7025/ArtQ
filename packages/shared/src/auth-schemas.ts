// Request schemas for authentication (api.md §3.4 storefront, §4.1 admin). The single definition used by the API
// endpoints AND the forms (CLAUDE.md "Validation rule"): forms may add client-only fields, never change a rule.
// Messages are written for the person filling the form; the API returns the same text in VALIDATION_ERROR details.
import { z } from 'zod';

export const EMAIL_MAX = 160;
export const NAME_MAX = 120;
export const PASSWORD_MAX = 128;
/** Customer passwords: 8–128. */
export const CUSTOMER_PASSWORD_MIN = 8;
/** Staff passwords: 12–128 (argon2 cost makes very long inputs a DoS vector). */
export const STAFF_PASSWORD_MIN = 12;

/** Trimmed, then a valid address of at most 160 characters. */
export const emailField = z.string().trim()
  .min(1, 'Enter your email address')
  .max(EMAIL_MAX, `Use at most ${EMAIL_MAX} characters`)
  .pipe(z.email('Enter a valid email address'));

export const nameField = z.string().trim().min(1, 'Enter a name').max(NAME_MAX, `Use at most ${NAME_MAX} characters`);

/** A password being typed to log in or re-check: anything non-empty up to the maximum. */
export const currentPasswordField = z.string().min(1, 'Enter your password').max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters`);

const newPassword = (min: number) => z.string().min(min, `Use at least ${min} characters`).max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters`);
export const customerPasswordField = newPassword(CUSTOMER_PASSWORD_MIN);
export const staffPasswordField = newPassword(STAFF_PASSWORD_MIN);

export const otpCodeField = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
export const phoneField = z.string().regex(/^\+?\d{10,14}$/, 'Enter a phone number of 10 to 14 digits');
const linkToken = z.string().min(10, 'This link is incomplete').max(1000, 'This link is not valid');

// ── Storefront (/v1/auth) ──────────────────────────────────────────────
export const signupBody = z.strictObject({
  name: nameField, email: emailField, password: customerPasswordField, marketingOptIn: z.boolean().default(false),
  phone: phoneField.optional(),
});
export const signupVerifyBody = z.strictObject({ email: emailField, code: otpCodeField });
export const loginBody = z.strictObject({ email: emailField, password: currentPasswordField });
export const otpRequestBody = z.strictObject({ email: emailField, purpose: z.literal('LOGIN') });
export const otpVerifyBody = z.strictObject({ email: emailField, purpose: z.literal('LOGIN'), code: otpCodeField });
export const forgotPasswordBody = z.strictObject({ email: emailField });
export const resetPasswordBody = z.strictObject({ token: linkToken, password: customerPasswordField });
export const emptyBody = z.strictObject({});

// ── Admin (/v1/admin/auth) ─────────────────────────────────────────────
export const adminLoginBody = z.strictObject({ email: emailField, password: currentPasswordField });
export const stepUpBody = z.strictObject({ password: currentPasswordField });
export const adminForgotPasswordBody = z.strictObject({ email: emailField });
/** Invite and reset links (staff minimum 12 characters). */
export const adminResetPasswordBody = z.strictObject({ token: z.string().min(16, 'This link is incomplete').max(200, 'This link is not valid'), password: staffPasswordField });

// ── Account (api.md §3.5, task 4.2). The storefront's account forms import these. ──
/** PATCH /me. Phone is contact-only at launch (not verified); null clears it. */
export const profileBody = z.strictObject({
  name: nameField,
  phone: z.union([phoneField, z.literal('').transform(() => null), z.null()]).optional(),
  marketingOptIn: z.boolean().optional(),
});
export const changePasswordBody = z.strictObject({ currentPassword: currentPasswordField, newPassword: customerPasswordField })
  .refine((b) => b.currentPassword !== b.newPassword, { path: ['newPassword'], message: 'Choose a password different from the current one' });
export const emailChangeBody = z.strictObject({ newEmail: emailField, password: currentPasswordField });
export const emailVerifyBody = z.strictObject({ code: otpCodeField });
export const deleteAccountBody = z.strictObject({ password: currentPasswordField, confirm: z.literal(true, { error: 'Tick the box to confirm' }) });

export const ADDRESS_LABELS = ['HOME', 'WORK', 'OTHER'] as const;
export const MAX_ADDRESSES = 10;
const line = (max: number, required: string) => z.string().trim().min(1, required).max(max, `Use at most ${max} characters`);
const optionalLine = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`).transform((v) => v || null).nullable().optional();
/** POST /me/addresses and PATCH /me/addresses/:id (India only at launch). */
export const addressBody = z.strictObject({
  label: z.enum(ADDRESS_LABELS).default('HOME'),
  fullName: line(120, 'Enter the name for delivery'),
  phone: phoneField,
  line1: line(200, 'Enter the house / building and street'),
  line2: optionalLine(200),
  landmark: optionalLine(120),
  city: line(80, 'Enter the city or town'),
  stateId: z.number({ error: 'Choose a state' }).int().positive('Choose a state'),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Enter a 6-digit pincode'),
  isDefault: z.boolean().optional(),
});
export type AddressInput = z.input<typeof addressBody>;

export const WISHLIST_MAX = 100;
export const wishlistToggleBody = z.strictObject({ productId: z.number().int().positive() });
export const wishlistMergeBody = z.strictObject({ productIds: z.array(z.number().int().positive()).max(WISHLIST_MAX, `At most ${WISHLIST_MAX} products`) });
