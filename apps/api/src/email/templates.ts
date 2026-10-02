// Email templates (plain TS for now; React Email can replace the HTML later without changing the consumer).
// Every interpolated value is HTML-escaped; links are only ever built by the API itself.

export type Rendered = { subject: string; text: string; html: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, paragraphs: string[], action?: { label: string; href: string }): string {
  const p = paragraphs.map((x) => `<p style="margin:0 0 16px">${esc(x)}</p>`).join('');
  const a = action ? `<p style="margin:24px 0"><a href="${esc(action.href)}" style="background:#00756f;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none">${esc(action.label)}</a></p>` : '';
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:560px;margin:auto;padding:24px"><h1 style="font-size:20px">${esc(title)}</h1>${p}${a}<p style="color:#64748b;font-size:12px">ArtQ · Handcrafted resin art and wooden frames</p></body></html>`;
}

export class UnknownTemplateError extends Error {
  constructor(name: string) { super(`unknown email template "${name}"`); this.name = 'UnknownTemplateError'; }
}

const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' && typeof v !== 'number') throw new TypeError(`template data "${name}" is missing`);
  return String(v);
};

const TEMPLATES: Record<string, (d: Record<string, unknown>) => Rendered> = {
  otp: (d) => {
    const code = str(d.code, 'code');
    const mins = str(d.expiresInMinutes ?? 10, 'expiresInMinutes');
    const what = d.purpose === 'SIGNUP_VERIFY' ? 'verify your email' : 'log in';
    return {
      subject: `${code} is your ArtQ code`,
      text: `Use ${code} to ${what}. It expires in ${mins} minutes. If you did not ask for it, ignore this email.`,
      html: layout('Your ArtQ code', [`Use this code to ${what}:`, code, `It expires in ${mins} minutes. If you did not ask for it, you can ignore this email.`]),
    };
  },
  password_reset: (d) => {
    const link = str(d.link, 'link');
    return {
      subject: 'Reset your ArtQ password',
      text: `Reset your password: ${link}\nThe link expires in 30 minutes. If you did not ask for it, ignore this email.`,
      html: layout('Reset your password', ['Use the button below to choose a new password. The link expires in 30 minutes.', 'If you did not ask for it, you can ignore this email.'], { label: 'Reset password', href: link }),
    };
  },
  staff_invite: (d) => {
    const link = str(d.link, 'link');
    const role = ({ STAFF: 'Staff', ADMIN: 'Admin', SUPER_ADMIN: 'Super Admin' } as Record<string, string>)[str(d.role, 'role')] ?? 'Staff';
    return {
      subject: 'You have been added to the ArtQ admin',
      text: `You now have ${role} access to the ArtQ admin. Choose your password here: ${link}\nThe link expires in 72 hours and works once.`,
      html: layout('Welcome to the ArtQ admin', [`You now have ${role} access to the ArtQ admin panel.`, 'Choose a password to sign in. The link expires in 72 hours and works once.'], { label: 'Choose password', href: link }),
    };
  },
  password_changed: () => ({
    subject: 'Your ArtQ password was changed',
    text: 'Your password was changed and you were logged out everywhere. If this was not you, reset your password now.',
    html: layout('Password changed', ['Your password was changed and you were logged out on every device.', 'If this was not you, reset your password straight away.']),
  }),
  signup_attempt_existing: () => ({
    subject: 'Someone tried to sign up with your email',
    text: 'Someone tried to create an ArtQ account with this email, which already has one. If it was you, log in or reset your password.',
    html: layout('You already have an account', ['Someone tried to create an ArtQ account with this email, which already has one.', 'If it was you, log in or reset your password. Otherwise you can ignore this email.']),
  }),
  new_signin_activity: () => ({
    subject: 'New sign-in activity on your ArtQ account',
    text: 'We ended a session on your account because a sign-in token was reused. If you notice anything unusual, reset your password.',
    html: layout('We secured your account', ['A sign-in token for your account was used twice, so we logged that session out.', 'If you notice anything unusual, reset your password.']),
  }),
  admin_payment_exception: (d) => {
    const type = str(d.type, 'type');
    const order = d.order_id === null || d.order_id === undefined ? 'no order' : `order id ${str(d.order_id, 'order_id')}`;
    return {
      subject: `[ArtQ] Payment exception: ${type}`,
      text: `A payment exception was raised: ${type} (${order}). Review it in Payments → Exceptions.`,
      html: layout('Payment exception', [`Type: ${type}`, `Related: ${order}`, 'Review it in Payments → Exceptions in the admin panel.']),
    };
  },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

export function render(template: string, data: Record<string, unknown>): Rendered {
  const t = TEMPLATES[template];
  if (!t) throw new UnknownTemplateError(template);
  return t(data);
}
