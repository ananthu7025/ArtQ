// Authentication for both audiences (architecture.md §5.1–5.8, api.md §3.4 / §4.1): storefront customers and admin staff.
// Admin login is email + password (MFA deferred by the owner, 2026-10-02); sensitive admin actions require a recent
// password re-check ("step-up", recorded in sessions.mfa_verified_at).
// PostgreSQL is the source of truth; emails are written to the outbox in the same transaction (delivered by task 1.8).
import type { Prisma, PrismaClient, User } from '@prisma/client';
import * as fn from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import { hashPassword, STAFF_PASSWORD_MIN, verifyPassword } from '../lib/password.js';
import type { SessionCache } from './session-cache.js';
import { otpCode, otpHash, randomToken, safeEqualHex, sha256, signAccessToken, signLink, verifyLink, type JwtConfig } from './tokens.js';

export type AuthConfig = {
  jwt: JwtConfig;
  otpPepper: string;
  linkSecret: string;
  webUrl: string;
  /** Admin SPA origin: staff invite and admin password-reset links point here. */
  adminUrl: string;
  accessTtlS: number;          // 600
  refreshIdleS: number;        // 30 d
  sessionAbsoluteS: number;    // 90 d
  graceS: number;              // 30
  otpTtlS: number;             // 600
  otpMaxAttempts: number;      // 5
  otpCooldownS: number;        // 30
  otpPerTargetPerHour: number; // 5
  resetTtlS: number;           // 1800
  setPasswordTtlS: number;     // 7 d
  inviteTtlS: number;          // 72 h (staff invite = first password link)
  lockoutThreshold: number;    // 5
  lockoutS: number;            // 900
  adminAccessTtlS: number;     // 300
  adminIdleS: number;          // 12 h
  adminAbsoluteS: number;      // 7 d
  stepUpWindowS: number;       // 600
};

export const DEFAULT_AUTH_TIMINGS = {
  accessTtlS: 600, refreshIdleS: 30 * 86_400, sessionAbsoluteS: 90 * 86_400, graceS: 30, otpTtlS: 600, otpMaxAttempts: 5,
  otpCooldownS: 30, otpPerTargetPerHour: 5, resetTtlS: 1800, setPasswordTtlS: 7 * 86_400, inviteTtlS: 72 * 3600, lockoutThreshold: 5, lockoutS: 900,
  adminAccessTtlS: 300, adminIdleS: 12 * 3600, adminAbsoluteS: 7 * 86_400, stepUpWindowS: 600,
} as const;

export type SessionAudience = 'STOREFRONT' | 'ADMIN';
export const STAFF_ROLES: readonly User['role'][] = ['STAFF', 'ADMIN', 'SUPER_ADMIN'];

export type ClientMeta = { ip: string | null; userAgent: string | null };
export type UserView = { id: number; name: string | null; email: string; emailVerified: boolean; phone: string | null; role: User['role']; marketingOptIn: boolean };
export type Issued = { accessToken: string; refreshToken: string; user: UserView };
export type RefreshOutcome =
  | { ok: true; accessToken: string; refreshToken: string | null; user: UserView }
  | { ok: false; reason: 'UNKNOWN' | 'INVALID' | 'EXPIRED' | 'REUSE' | 'WRONG_AUDIENCE' };

type Tx = Prisma.TransactionClient;
type OtpKind = 'SIGNUP_VERIFY' | 'LOGIN' | 'EMAIL_CHANGE' | 'GUEST_ORDER_ACCESS';
const TX = { maxWait: 10_000, timeout: 20_000 } as const;

export const userView = (u: User): UserView => ({
  id: u.id, name: u.name, email: u.email, emailVerified: u.emailVerifiedAt !== null, phone: u.phone, role: u.role, marketingOptIn: u.marketingOptIn,
});

export const maskEmail = (email: string) => {
  const [local, domain] = email.split('@') as [string, string];
  return `${local.slice(0, 1)}***@${domain}`;
};

export const normaliseEmail = (e: string) => e.trim().toLowerCase();

export class AuthService {
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly prisma: PrismaClient, private readonly cache: SessionCache, private readonly cfg: AuthConfig) {}

  // ── Signup ───────────────────────────────────────────────────────────────

  /** Always answers the same way; an existing verified account gets a "someone tried to sign up" email instead. */
  async signup(input: { name: string; email: string; phone?: string | undefined; password: string; marketingOptIn: boolean }): Promise<{ otpSentTo: string }> {
    const email = normaliseEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    await this.prisma.$transaction(async (tx) => {
      await this.lockTarget(tx, email);
      const existing = await this.liveUser(tx, email);
      if (existing && existing.status !== 'PENDING_VERIFICATION') {
        await this.mail(tx, existing.id, email, 'signup_attempt_existing', {});
        return;
      }
      const user = existing
        ? await tx.user.update({ where: { id: existing.id }, data: { name: input.name, phone: input.phone ?? null, passwordHash, marketingOptIn: input.marketingOptIn } })
        : await tx.user.create({ data: { name: input.name, email, phone: input.phone ?? null, passwordHash, marketingOptIn: input.marketingOptIn, status: 'PENDING_VERIFICATION' } });
      await this.issueOtp(tx, email, 'SIGNUP_VERIFY', user.id);
    }, TX);
    return { otpSentTo: maskEmail(email) };
  }

  async verifySignup(input: { email: string; code: string }, meta: ClientMeta): Promise<Issued> {
    const email = normaliseEmail(input.email);
    return this.otpTransaction(email, 'SIGNUP_VERIFY', input.code, async (tx) => {
      const user = await this.liveUser(tx, email);
      if (!user || user.status !== 'PENDING_VERIFICATION') throw new AppError(422, 'OTP_INVALID', 'The code is not valid');
      const active = await tx.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', emailVerifiedAt: new Date() } });
      await this.linkGuestOrders(tx, active);
      return this.startSession(tx, active, meta, 'STOREFRONT');
    });
  }

  // ── Login ────────────────────────────────────────────────────────────────

  async login(input: { email: string; password: string }, meta: ClientMeta): Promise<Issued> {
    const user = await this.checkPassword(normaliseEmail(input.email), input.password);
    if (user.status === 'PENDING_VERIFICATION') throw new AppError(403, 'NOT_VERIFIED', 'Verify your email to continue');
    if (user.status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_BLOCKED', 'This account is disabled');
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
      await this.linkGuestOrders(tx, u);       // a verified account holder who checked out as a guest (architecture.md §5.6)
      return this.startSession(tx, u, meta, 'STOREFRONT');
    }, TX);
  }

  /**
   * Admin panel login (api.md §4.1): staff roles only, separate session audience and cookie. A non-staff account gets
   * the same INVALID_CREDENTIALS as a wrong password, so the admin login never reveals who has an account.
   */
  async adminLogin(input: { email: string; password: string }, meta: ClientMeta): Promise<Issued> {
    const user = await this.checkPassword(normaliseEmail(input.email), input.password);
    if (!STAFF_ROLES.includes(user.role) || user.status === 'PENDING_VERIFICATION') {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    if (user.status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_BLOCKED', 'This account is disabled');
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: u.id, action: 'admin.login', entity: 'user', entityId: String(u.id), ip: meta.ip, userAgent: meta.userAgent?.slice(0, 500) ?? null } });
      return this.startSession(tx, u, meta, 'ADMIN');
    }, TX);
  }

  /**
   * Step-up for sensitive admin actions (architecture.md §5.8, password instead of TOTP while MFA is deferred):
   * re-entering the password marks the session as recently re-authenticated. Wrong passwords count toward the lockout.
   */
  async adminStepUp(sessionId: string, userId: number, password: string): Promise<{ stepUpUntil: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.checkPassword(user.email, password);
    const [r] = await this.prisma.$queryRaw<{ until: Date }[]>`
      UPDATE sessions SET mfa_verified_at = now() WHERE id = ${sessionId}::uuid AND audience = 'ADMIN' AND revoked_at IS NULL
      RETURNING now() + make_interval(secs => ${this.cfg.stepUpWindowS}::int) AS until`;
    if (!r) throw new AppError(401, 'SESSION_INVALID', 'Your session has ended. Please log in again.');
    await this.prisma.auditLog.create({ data: { actorId: userId, sessionId, action: 'admin.step_up', entity: 'session', entityId: sessionId } });
    return { stepUpUntil: r.until.toISOString() };
  }

  /**
   * Role change (architecture.md §5.4): admin sessions end at once (DB + cache); storefront sessions stay valid.
   * `within` runs first in the same transaction (guards and the audit row of the caller).
   */
  async changeRole(userId: number, role: User['role'], within?: (tx: Tx) => Promise<void>): Promise<void> {
    const sids = await this.prisma.$transaction(async (tx) => {
      await within?.(tx);
      const live = await tx.session.findMany({ where: { userId, audience: 'ADMIN', revokedAt: null }, select: { id: true } });
      await fn.changeRole(tx, userId, role);
      await tx.$executeRaw`UPDATE refresh_tokens SET status = 'REVOKED' WHERE status <> 'REVOKED' AND session_id IN (SELECT id FROM sessions WHERE user_id = ${userId} AND audience = 'ADMIN')`;
      return live.map((s) => s.id);
    }, TX);
    await this.cache.revoke(sids);
  }

  /** Always `{sent:true, resendAfter}`; a code is only created for an ACTIVE account and within the per-target limits. */
  async requestLoginOtp(input: { email: string }): Promise<{ sent: true; resendAfter: number }> {
    const email = normaliseEmail(input.email);
    await this.prisma.$transaction(async (tx) => {
      await this.lockTarget(tx, email);
      const user = await this.liveUser(tx, email);
      if (user?.status === 'ACTIVE') await this.issueOtp(tx, email, 'LOGIN', user.id);
    }, TX);
    return { sent: true, resendAfter: this.cfg.otpCooldownS };
  }

  async verifyLoginOtp(input: { email: string; code: string }, meta: ClientMeta): Promise<Issued> {
    const email = normaliseEmail(input.email);
    return this.otpTransaction(email, 'LOGIN', input.code, async (tx) => {
      const user = await this.liveUser(tx, email);
      if (!user || user.status !== 'ACTIVE') throw new AppError(422, 'OTP_INVALID', 'The code is not valid');
      const u = await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
      await this.linkGuestOrders(tx, u);
      return this.startSession(tx, u, meta, 'STOREFRONT');
    });
  }

  // ── Refresh (architecture.md §5.2) ───────────────────────────────────────

  async refresh(refreshToken: string | undefined, audience: SessionAudience = 'STOREFRONT'): Promise<RefreshOutcome> {
    const t = this.timings(audience);
    if (!refreshToken) return { ok: false, reason: 'UNKNOWN' };
    const revoked: string[] = [];
    const out = await this.prisma.$transaction(async (tx): Promise<RefreshOutcome> => {
      // 1. Lock the presented token: concurrent refreshes of the same token serialise here.
      const [rt] = await tx.$queryRaw<{ id: string; status: 'ACTIVE' | 'ROTATED' | 'REVOKED'; session_id: string }[]>`
        SELECT id, status, session_id FROM refresh_tokens WHERE token_hash = ${sha256(refreshToken)} FOR NO KEY UPDATE`;
      if (!rt) return { ok: false, reason: 'UNKNOWN' };
      // 2. Evaluate in a later statement so the snapshot includes whatever the previous lock holder committed.
      const [s] = await tx.$queryRaw<{ user_id: number; audience: 'STOREFRONT' | 'ADMIN'; auth_version: number; valid: boolean; expired: boolean; in_grace: boolean; successor_active: boolean }[]>`
        SELECT s.user_id, s.audience, s.auth_version, aq_session_valid(s.id) AS valid,
               rt.expires_at <= now() AS expired,
               coalesce(rt.rotated_at > now() - make_interval(secs => ${this.cfg.graceS}::int), false) AS in_grace,
               EXISTS (SELECT 1 FROM refresh_tokens c WHERE c.parent_id = rt.id AND c.status = 'ACTIVE') AS successor_active
          FROM refresh_tokens rt JOIN sessions s ON s.id = rt.session_id WHERE rt.id = ${rt.id}::uuid`;
      if (!s) return { ok: false, reason: 'UNKNOWN' };
      if (s.audience !== audience) return { ok: false, reason: 'WRONG_AUDIENCE' };
      if (!s.valid || rt.status === 'REVOKED') {
        await this.revokeSession(tx, rt.session_id, 'INVALID');
        revoked.push(rt.session_id);
        return { ok: false, reason: 'INVALID' };
      }
      const user = await tx.user.findUniqueOrThrow({ where: { id: s.user_id } });
      if (rt.status === 'ACTIVE') {
        if (s.expired) return { ok: false, reason: 'EXPIRED' };
        const next = randomToken();
        await tx.$executeRaw`UPDATE refresh_tokens SET status = 'ROTATED', rotated_at = now() WHERE id = ${rt.id}::uuid`;
        await tx.$executeRaw`
          WITH s AS (UPDATE sessions SET last_used_at = now(),
                       idle_expires_at = least(now() + make_interval(secs => ${t.idleS}::int), absolute_expires_at)
                     WHERE id = ${rt.session_id}::uuid RETURNING idle_expires_at)
          INSERT INTO refresh_tokens (session_id, token_hash, parent_id, expires_at)
          SELECT ${rt.session_id}::uuid, ${sha256(next)}, ${rt.id}::uuid, idle_expires_at FROM s`;
        return { ok: true, accessToken: await this.access(user, rt.session_id, s.auth_version, audience), refreshToken: next, user: userView(user) };
      }
      // ROTATED: a second tab inside the grace window gets an access token but no new refresh token.
      if (s.in_grace && s.successor_active) {
        return { ok: true, accessToken: await this.access(user, rt.session_id, s.auth_version, audience), refreshToken: null, user: userView(user) };
      }
      // Reuse of a rotated token outside the grace window: assume theft.
      await this.revokeSession(tx, rt.session_id, 'REUSE_DETECTED');
      revoked.push(rt.session_id);
      await tx.auditLog.create({ data: { actorId: user.id, sessionId: rt.session_id, action: 'security.refresh_reuse', entity: 'session', entityId: rt.session_id } });
      await this.mail(tx, user.id, user.email, 'new_signin_activity', {});
      return { ok: false, reason: 'REUSE' };
    }, TX);
    await this.cache.revoke(revoked);
    return out;
  }

  // ── Logout ───────────────────────────────────────────────────────────────

  async logout(refreshToken: string | undefined, audience: SessionAudience = 'STOREFRONT'): Promise<void> {
    if (!refreshToken) return;
    const sid = await this.prisma.$transaction(async (tx) => {
      const rt = await tx.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) }, include: { session: true } });
      if (!rt || rt.session.audience !== audience) return null;
      await this.revokeSession(tx, rt.sessionId, 'LOGOUT');
      return rt.sessionId;
    }, TX);
    if (sid) await this.cache.revoke([sid]);
  }

  async logoutAll(userId: number): Promise<void> {
    await this.revokeAll(userId, 'LOGOUT_ALL');
  }

  // ── Passwords ────────────────────────────────────────────────────────────

  async forgotPassword(input: { email: string }): Promise<{ ok: true }> {
    const email = normaliseEmail(input.email);
    await this.prisma.$transaction(async (tx) => {
      await this.lockTarget(tx, email);
      const user = await this.liveUser(tx, email);
      if (user?.status !== 'ACTIVE') return;
      await this.issueResetLink(tx, user, this.cfg.webUrl, 'password_reset', this.cfg.resetTtlS);
    }, TX);
    return { ok: true };
  }

  /** Admin "forgot password": same rules as the storefront, only for staff accounts, link to the admin app. */
  async adminForgotPassword(input: { email: string }): Promise<{ ok: true }> {
    const email = normaliseEmail(input.email);
    await this.prisma.$transaction(async (tx) => {
      await this.lockTarget(tx, email);
      const user = await this.liveUser(tx, email);
      if (user?.status !== 'ACTIVE' || !STAFF_ROLES.includes(user.role)) return;
      await this.issueResetLink(tx, user, this.cfg.adminUrl, 'password_reset', this.cfg.resetTtlS);
    }, TX);
    return { ok: true };
  }

  /**
   * Staff invite (or a fresh link from the Staff page): a single-use password link to the admin app, valid 72 h.
   * Returns false when the per-account hourly link limit is reached.
   */
  async sendStaffInvite(tx: Tx, user: User): Promise<boolean> {
    await this.lockTarget(tx, user.email);
    return this.issueResetLink(tx, user, this.cfg.adminUrl, 'staff_invite', this.cfg.inviteTtlS, { role: user.role, name: user.name ?? '' });
  }

  private async issueResetLink(tx: Tx, user: User, base: string, template: string, ttlS: number, extra: Record<string, unknown> = {}): Promise<boolean> {
    const recent = await tx.passwordResetToken.count({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
    if (recent >= this.cfg.otpPerTargetPerHour) return false;
    const token = randomToken();
    await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlS * 1000) } });
    await this.mail(tx, user.id, user.email, template, { ...extra, link: `${base.replace(/\/$/, '')}/reset-password?token=${token}` });
    return true;
  }

  async resetPassword(input: { token: string; password: string }): Promise<{ ok: true }> {
    const passwordHash = await hashPassword(input.password);
    const userId = await this.prisma.$transaction(async (tx) => {
      const [t] = await tx.$queryRaw<{ id: number; user_id: number }[]>`
        UPDATE password_reset_tokens SET used_at = now()
         WHERE token_hash = ${sha256(input.token)} AND used_at IS NULL AND expires_at > now() RETURNING id, user_id`;
      if (!t) throw new AppError(422, 'TOKEN_INVALID', 'This link is invalid or has expired');
      const user = await tx.user.findUnique({ where: { id: t.user_id } });
      if (!user || user.status !== 'ACTIVE' || user.deletedAt) throw new AppError(422, 'TOKEN_INVALID', 'This link is invalid or has expired');
      if (STAFF_ROLES.includes(user.role) && input.password.length < STAFF_PASSWORD_MIN) {
        // Staff accounts need the longer staff minimum whichever reset page (storefront or admin) is used.
        throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'password', message: `Use at least ${STAFF_PASSWORD_MIN} characters` }]);
      }
      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });   // other links die too
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: user.emailVerifiedAt ?? new Date() } });   // the link proved the mailbox
      await this.mail(tx, user.id, user.email, 'password_changed', {});
      return user.id;
    }, TX);
    await this.revokeAll(userId, 'PASSWORD_RESET');
    return { ok: true };
  }

  /** Link for the post-checkout email (architecture.md §5.6): proves ownership of `email` when used. */
  setPasswordLink(email: string, now = new Date()): string {
    const token = signLink(this.cfg.linkSecret, 'set_password', { e: normaliseEmail(email) }, this.cfg.setPasswordTtlS, now);
    return `${this.cfg.webUrl}/set-password?token=${token}`;
  }

  async setPassword(input: { token: string; password: string }, meta: ClientMeta): Promise<Issued> {
    const data = verifyLink(this.cfg.linkSecret, 'set_password', input.token);
    if (!data || typeof data.e !== 'string') throw new AppError(422, 'TOKEN_INVALID', 'This link is invalid or has expired');
    const email = data.e;
    const passwordHash = await hashPassword(input.password);
    return this.prisma.$transaction(async (tx) => {
      await this.lockTarget(tx, email);
      const existing = await this.liveUser(tx, email);
      if (existing && existing.status === 'ACTIVE' && existing.passwordHash) {
        throw new AppError(409, 'ACCOUNT_EXISTS', 'An account already exists for this email. Log in or reset your password.');
      }
      if (existing && existing.status !== 'ACTIVE' && existing.status !== 'PENDING_VERIFICATION') {
        throw new AppError(403, 'ACCOUNT_BLOCKED', 'This account is disabled');
      }
      const user = existing
        ? await tx.user.update({ where: { id: existing.id }, data: { passwordHash, status: 'ACTIVE', emailVerifiedAt: existing.emailVerifiedAt ?? new Date() } })
        : await tx.user.create({ data: { email, passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() } });
      await this.linkGuestOrders(tx, user);
      return this.startSession(tx, user, meta, 'STOREFRONT');
    }, TX);
  }

  async me(userId: number): Promise<UserView> {
    return userView(await this.prisma.user.findUniqueOrThrow({ where: { id: userId } }));
  }

  // ── Account (api.md §3.5, task 4.2) ──────────────────────────────────────

  async updateProfile(userId: number, input: { name: string; phone?: string | null | undefined; marketingOptIn?: boolean | undefined }): Promise<UserView> {
    const u = await this.prisma.user.update({ where: { id: userId }, data: { name: input.name, ...(input.phone !== undefined ? { phone: input.phone } : {}), ...(input.marketingOptIn !== undefined ? { marketingOptIn: input.marketingOptIn } : {}) } });
    return userView(u);
  }

  /**
   * Re-checks the signed-in user's password for an account change. Wrong guesses count towards the login lockout;
   * a wrong password is reported on the form field (400), not as a lost session (a 401 would send the client to log in).
   */
  private async confirmPassword(userId: number, password: string, field: string): Promise<User> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw new AppError(401, 'SESSION_INVALID', 'Your session has ended. Please log in again.');
    try { return await this.checkPassword(user.email, password); }
    catch (e) {
      if (e instanceof AppError && e.code === 'INVALID_CREDENTIALS') throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: field, message: 'This password is not correct' }]);
      throw e;
    }
  }

  /** Changes the password and logs out everywhere (architecture.md §5.2 table); the client logs in again. */
  async changePassword(userId: number, input: { currentPassword: string; newPassword: string }): Promise<{ ok: true }> {
    const user = await this.confirmPassword(userId, input.currentPassword, 'currentPassword');
    const passwordHash = await hashPassword(input.newPassword);
    await this.revokeAll(userId, 'PASSWORD_CHANGED', false, async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
      await this.mail(tx, userId, user.email, 'password_changed', {});
    });
    return { ok: true };
  }

  /** Sends a code to the new address (it must prove the mailbox) and tells the current address. */
  async requestEmailChange(userId: number, input: { newEmail: string; password: string }): Promise<{ otpSentTo: string }> {
    const user = await this.confirmPassword(userId, input.password, 'password');
    const newEmail = normaliseEmail(input.newEmail);
    const field = (message: string) => new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'newEmail', message }]);
    if (newEmail === user.email) throw field('This is already your email address');
    if (await this.liveUser(this.prisma, newEmail)) throw field('Another account uses this email address');
    await this.prisma.$transaction(async (tx) => {
      await this.issueOtp(tx, newEmail, 'EMAIL_CHANGE', userId);
      await this.mail(tx, userId, user.email, 'email_change_requested', { newEmail: maskEmail(newEmail) });
    }, TX);
    return { otpSentTo: maskEmail(newEmail) };
  }

  /** Confirms the code sent to the new address, switches the email and logs out everywhere (api.md §3.5). */
  async verifyEmailChange(userId: number, input: { code: string }): Promise<{ ok: true; email: string }> {
    const [pending] = await this.prisma.$queryRaw<{ target: string }[]>`
      SELECT target FROM otp_codes WHERE user_id = ${userId} AND purpose = 'EMAIL_CHANGE' AND consumed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`;
    if (!pending) throw new AppError(422, 'OTP_INVALID', 'The code is not valid');
    const old = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.otpTransaction(pending.target, 'EMAIL_CHANGE', input.code, async (tx) => {
      if (await tx.user.findFirst({ where: { email: pending.target, deletedAt: null, id: { not: userId } } })) throw new AppError(409, 'EMAIL_TAKEN', 'Another account uses this email address');
      await tx.user.update({ where: { id: userId }, data: { email: pending.target, emailVerifiedAt: new Date() } });
      await this.mail(tx, userId, old.email, 'email_changed', { newEmail: maskEmail(pending.target) });
    });
    await this.revokeAll(userId, 'EMAIL_CHANGED');
    return { ok: true, email: pending.target };
  }

  /** Soft delete (api.md §3.5): logged out everywhere now; personal data anonymised after 30 days; orders are kept. */
  async deleteAccount(userId: number, input: { password: string }): Promise<{ ok: true }> {
    const user = await this.confirmPassword(userId, input.password, 'password');
    await this.revokeAll(userId, 'ACCOUNT_DELETED', false, async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
      await tx.cart.updateMany({ where: { userId, status: 'ACTIVE' }, data: { status: 'ABANDONED' } });
      await this.mail(tx, userId, user.email, 'account_deleted', {});
      await tx.auditLog.create({ data: { actorId: userId, action: 'account.delete', entity: 'user', entityId: String(userId) } });
    });
    return { ok: true };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private locked(until: Date) {
    return new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', { retryAfterSeconds: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)) });
  }

  private dummy(): Promise<string> {
    return (this.dummyHash ??= hashPassword('artq-dummy-password-for-timing'));
  }

  private liveUser(db: Tx | PrismaClient, email: string) {
    return db.user.findFirst({ where: { email, deletedAt: null } });
  }

  /** Serialises per-email operations (signup races, OTP issue limits). */
  async lockTarget(tx: Tx, email: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('auth:' || ${email}))`;
  }

  private timings(audience: SessionAudience) {
    return audience === 'ADMIN'
      ? { accessTtlS: this.cfg.adminAccessTtlS, idleS: this.cfg.adminIdleS, absoluteS: this.cfg.adminAbsoluteS }
      : { accessTtlS: this.cfg.accessTtlS, idleS: this.cfg.refreshIdleS, absoluteS: this.cfg.sessionAbsoluteS };
  }

  /** Lifetime in seconds of the refresh cookie for an audience (its idle expiry). */
  refreshCookieMaxAge(audience: SessionAudience): number {
    return this.timings(audience).idleS;
  }

  private access(user: User, sid: string, ver: number, audience: SessionAudience) {
    return signAccessToken(this.cfg.jwt, { sub: String(user.id), sid, aud: audience === 'ADMIN' ? 'admin' : 'storefront', ver }, this.timings(audience).accessTtlS);
  }

  /** Verifies email + password with the shared lockout (5 failures → 15 min). Returns the live user; status is the caller's check. */
  private async checkPassword(email: string, password: string): Promise<User> {
    const user = await this.liveUser(this.prisma, email);
    if (!user || !user.passwordHash) {
      await verifyPassword(await this.dummy(), password);      // same cost whether or not the account exists
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) throw this.locked(user.lockedUntil);
    if (!(await verifyPassword(user.passwordHash, password))) {
      const [u] = await this.prisma.$queryRaw<{ locked_until: Date | null }[]>`
        UPDATE users SET
          locked_until = CASE WHEN failed_login_count + 1 >= ${this.cfg.lockoutThreshold}::int THEN now() + make_interval(secs => ${this.cfg.lockoutS}::int) ELSE locked_until END,
          failed_login_count = CASE WHEN failed_login_count + 1 >= ${this.cfg.lockoutThreshold}::int THEN 0 ELSE failed_login_count + 1 END
        WHERE id = ${user.id} RETURNING locked_until`;
      if (u?.locked_until && u.locked_until > new Date()) throw this.locked(u.locked_until);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    return user;
  }

  private async startSession(tx: Tx, user: User, meta: ClientMeta, audience: SessionAudience): Promise<Issued> {
    const refreshToken = randomToken();
    const t = this.timings(audience);
    const version = audience === 'ADMIN' ? user.adminAuthVersion : user.storefrontAuthVersion;
    const [s] = await tx.$queryRaw<{ id: string; auth_version: number }[]>`
      WITH s AS (INSERT INTO sessions (user_id, audience, auth_version, ip, user_agent, idle_expires_at, absolute_expires_at)
                 VALUES (${user.id}, ${audience}::"SessionAudience", ${version}, ${meta.ip}::inet, ${meta.userAgent?.slice(0, 500) ?? null},
                         now() + make_interval(secs => ${t.idleS}::int), now() + make_interval(secs => ${t.absoluteS}::int))
                 RETURNING id, auth_version, idle_expires_at)
      , r AS (INSERT INTO refresh_tokens (session_id, token_hash, expires_at) SELECT id, ${sha256(refreshToken)}, idle_expires_at FROM s)
      SELECT id::text, auth_version FROM s`;
    return { accessToken: await this.access(user, s!.id, s!.auth_version, audience), refreshToken, user: userView(user) };
  }

  /** Whether the admin session re-entered its password within the step-up window. */
  async hasRecentStepUp(sessionId: string): Promise<boolean> {
    const [r] = await this.prisma.$queryRaw<{ ok: boolean }[]>`
      SELECT coalesce(mfa_verified_at > now() - make_interval(secs => ${this.cfg.stepUpWindowS}::int), false) AS ok FROM sessions WHERE id = ${sessionId}::uuid`;
    return r?.ok ?? false;
  }

  private async revokeSession(tx: Tx, sid: string, reason: string) {
    await tx.$executeRaw`UPDATE sessions SET revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, ${reason}) WHERE id = ${sid}::uuid`;
    await tx.$executeRaw`UPDATE refresh_tokens SET status = 'REVOKED' WHERE session_id = ${sid}::uuid AND status <> 'REVOKED'`;
  }

  /** aq_revoke_all_sessions (both auth versions++) and cache tombstones for every live session of the user. */
  async revokeAll(userId: number, reason: string, block = false, within?: (tx: Tx) => Promise<void>): Promise<void> {
    const sids = await this.prisma.$transaction(async (tx) => {
      await within?.(tx);
      const live = await tx.session.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
      await fn.revokeAllSessions(tx, userId, reason, block);
      await tx.$executeRaw`UPDATE refresh_tokens SET status = 'REVOKED' WHERE status <> 'REVOKED' AND session_id IN (SELECT id FROM sessions WHERE user_id = ${userId})`;
      return live.map((s) => s.id);
    }, TX);
    await this.cache.revoke(sids);
  }

  private async issueOtp(tx: Tx, target: string, purpose: OtpKind, userId: number | null, orderId: number | null = null, extra: Record<string, unknown> = {}) {
    const [w] = await tx.$queryRaw<{ last_hour: number; recent: number }[]>`
      SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS last_hour,
             count(*) FILTER (WHERE created_at > now() - make_interval(secs => ${this.cfg.otpCooldownS}::int))::int AS recent
        FROM otp_codes WHERE target = ${target} AND purpose = ${purpose}::"OtpPurpose" AND order_id IS NOT DISTINCT FROM ${orderId}::int`;
    if (w!.recent > 0 || w!.last_hour >= this.cfg.otpPerTargetPerHour) return;      // silently: the response never reveals it
    const code = otpCode();
    await tx.otpCode.create({ data: { target, channel: 'EMAIL', purpose, codeHash: otpHash(code, this.cfg.otpPepper), userId, orderId, expiresAt: new Date(Date.now() + this.cfg.otpTtlS * 1000) } });
    await this.mail(tx, userId, target, 'otp', { code, purpose, expiresInMinutes: Math.round(this.cfg.otpTtlS / 60), ...extra });
  }

  /**
   * Verifies the latest code for target/purpose (5 attempts, single use) and runs `then` in the same transaction.
   * A wrong code still commits its attempt count; the error is thrown after the commit.
   */
  private async otpTransaction<T>(target: string, purpose: OtpKind, code: string, then: (tx: Tx) => Promise<T>, orderId: number | null = null): Promise<T> {
    const r = await this.prisma.$transaction(async (tx): Promise<{ error: AppError } | { value: T }> => {
      const [otp] = await tx.$queryRaw<{ id: number; code_hash: string; attempts: number; expired: boolean; consumed: boolean }[]>`
        SELECT id, code_hash, attempts, expires_at <= now() AS expired, consumed_at IS NOT NULL AS consumed
          FROM otp_codes WHERE target = ${target} AND purpose = ${purpose}::"OtpPurpose" AND order_id IS NOT DISTINCT FROM ${orderId}::int
         ORDER BY created_at DESC, id DESC LIMIT 1 FOR NO KEY UPDATE`;
      if (!otp || otp.consumed) return { error: new AppError(422, 'OTP_INVALID', 'The code is not valid') };
      if (otp.expired) return { error: new AppError(422, 'OTP_EXPIRED', 'The code has expired. Request a new one.') };
      if (otp.attempts >= this.cfg.otpMaxAttempts) return { error: new AppError(422, 'OTP_INVALID', 'Too many attempts. Request a new code.') };
      await tx.$executeRaw`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ${otp.id}`;
      if (!/^\d{6}$/.test(code) || !safeEqualHex(otp.code_hash, otpHash(code, this.cfg.otpPepper))) {
        return { error: new AppError(422, 'OTP_INVALID', 'The code is not valid') };
      }
      await tx.$executeRaw`UPDATE otp_codes SET consumed_at = now() WHERE id = ${otp.id}`;
      return { value: await then(tx) };
    }, TX);
    if ('error' in r) throw r.error;
    return r.value;
  }

  // ── Guest order access (architecture.md §5.6, task 5.7) ──
  /**
   * A code to the order's contact email, only when `email` matches it (case-insensitive) and the order is not a pending
   * checkout; the answer never says which. Codes are bound to the order: one for another order never opens this one.
   */
  async requestOrderAccess(orderId: number, emailIn: string): Promise<{ sent: true; resendAfter: number }> {
    const email = emailIn.trim().toLowerCase();
    await this.prisma.$transaction(async (tx) => {
      const o = await tx.order.findUnique({ where: { id: orderId }, select: { contactEmail: true, orderNumber: true, status: true } });
      if (o && o.status !== 'PENDING_PAYMENT' && o.contactEmail.toLowerCase() === email) await this.issueOtp(tx, email, 'GUEST_ORDER_ACCESS', null, orderId, { orderNumber: o.orderNumber });
    }, TX);
    return { sent: true, resendAfter: this.cfg.otpCooldownS };
  }

  /** Checks the code for this order; marks the contact email verified. The caller then issues the order cookie. */
  async verifyOrderAccess(orderId: number, emailIn: string, code: string): Promise<void> {
    const email = emailIn.trim().toLowerCase();
    await this.otpTransaction(email, 'GUEST_ORDER_ACCESS', code, async (tx) => {
      await tx.$executeRaw`UPDATE orders SET contact_email_verified_at = coalesce(contact_email_verified_at, now()) WHERE id = ${orderId}`;
    }, orderId);
  }

  /** Verified-email linking (architecture.md §5.6): guest orders with this contact email join the account. */
  private async linkGuestOrders(tx: Tx, user: User) {
    if (!user.emailVerifiedAt) return;                       // only a proven mailbox may claim orders
    const linked = await tx.$queryRaw<{ id: number }[]>`
      UPDATE orders SET user_id = ${user.id}, contact_email_verified_at = coalesce(contact_email_verified_at, now())
       WHERE user_id IS NULL AND contact_email = ${user.email}::citext RETURNING id`;
    if (linked.length) {
      await tx.auditLog.create({ data: { actorId: user.id, action: 'orders.link_verified_email', entity: 'user', entityId: String(user.id), after: { orderIds: linked.map((o) => o.id) } } });
    }
  }

  private async mail(tx: Tx, userId: number | null, to: string, template: string, data: Record<string, unknown>) {
    await fn.emit(tx, { aggregateType: 'user', aggregateId: String(userId ?? 0), type: 'email.auth', payload: { template, to, data }, consumers: ['email.customer'] });
  }
}
