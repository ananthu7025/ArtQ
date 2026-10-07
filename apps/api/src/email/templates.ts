// Email templates (plain TS for now; React Email can replace the HTML later without changing the consumer).
// Every interpolated value is HTML-escaped; links are only ever built by the API itself.
import { formatINR } from '@artq/shared';

export type Rendered = { subject: string; text: string; html: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, paragraphs: string[], action?: { label: string; href: string }): string {
  const p = paragraphs.map((x) => `<p style="margin:0 0 16px">${esc(x)}</p>`).join('');
  const a = action ? `<p style="margin:24px 0"><a href="${esc(action.href)}" style="background:#00756f;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none">${esc(action.label)}</a></p>` : '';
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:560px;margin:auto;padding:24px"><h1 style="font-size:20px">${esc(title)}</h1>${p}${a}<p style="color:#64748b;font-size:12px">ArtQ · Handcrafted resin art and wooden frames</p></body></html>`;
}

type OrderLine = { name: string; label: string; quantity: number; total: number };
type Totals = { subtotal: number; couponDiscount: number; couponCode: string | null; shipping: number; codFee: number; total: number };

/** The order email: greeting, items table, totals, address and what happens next. */
function orderHtml(title: string, intro: string[], lines: OrderLine[], t: Totals, address: string[], outro: string[], action?: { label: string; href: string }): string {
  const row = (l: string, r: string, strong = false) => `<tr><td style="padding:4px 0;${strong ? 'font-weight:600' : 'color:#475569'}">${esc(l)}</td><td style="padding:4px 0;text-align:right;${strong ? 'font-weight:600' : ''}">${esc(r)}</td></tr>`;
  const items = lines.map((l) => `<tr><td style="padding:6px 0;border-bottom:1px solid #e2e8f0">${esc(l.name)}<br><span style="color:#64748b;font-size:13px">${esc(l.label)} · Qty ${l.quantity}</span></td><td style="padding:6px 0;border-bottom:1px solid #e2e8f0;text-align:right">${esc(formatINR(l.total))}</td></tr>`).join('');
  const totals = [row('Subtotal', formatINR(t.subtotal)), t.couponDiscount ? row(`Coupon${t.couponCode ? ` ${t.couponCode}` : ''}`, `−${formatINR(t.couponDiscount)}`) : '', row('Shipping', t.shipping ? formatINR(t.shipping) : 'Free'), t.codFee ? row('Cash on delivery fee', formatINR(t.codFee)) : '', row('Total', formatINR(t.total), true)].join('');
  const body = `${intro.map((x) => `<p style="margin:0 0 16px">${esc(x)}</p>`).join('')}<table style="width:100%;border-collapse:collapse;font-size:14px">${items}</table><table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px">${totals}</table><p style="margin:16px 0 4px;font-weight:600">Delivering to</p><p style="margin:0 0 16px;color:#475569">${address.map(esc).join('<br>')}</p>${outro.map((x) => `<p style="margin:0 0 16px">${esc(x)}</p>`).join('')}`;
  const a = action ? `<p style="margin:24px 0"><a href="${esc(action.href)}" style="background:#00756f;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none">${esc(action.label)}</a></p>` : '';
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:560px;margin:auto;padding:24px"><h1 style="font-size:20px">${esc(title)}</h1>${body}${a}<p style="color:#64748b;font-size:12px">ArtQ · Handcrafted resin art and wooden frames</p></body></html>`;
}
const orderText = (intro: string[], lines: OrderLine[], t: Totals, address: string[], outro: string[]) =>
  [...intro, '', ...lines.map((l) => `${l.quantity} × ${l.name} (${l.label}): ${formatINR(l.total)}`), '', `Total: ${formatINR(t.total)}`, '', 'Delivering to:', ...address, '', ...outro].join('\n');
const lines = (v: unknown) => { if (!Array.isArray(v) || v.length === 0) throw new TypeError('template data "lines" is missing'); return v as OrderLine[]; };
const totals = (v: unknown) => { if (!v || typeof v !== 'object') throw new TypeError('template data "totals" is missing'); return v as Totals; };
const strs = (v: unknown, name: string) => { if (!Array.isArray(v)) throw new TypeError(`template data "${name}" is missing`); return v.map(String); };

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
    const what = d.purpose === 'SIGNUP_VERIFY' ? 'verify your email' : d.purpose === 'EMAIL_CHANGE' ? 'confirm your new email address' : 'log in';
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
  email_change_requested: (d) => {
    const to = str(d.newEmail, 'newEmail');
    return {
      subject: 'Your ArtQ email address is being changed',
      text: `Someone asked to change the email of your ArtQ account to ${to}. If this was not you, reset your password now.`,
      html: layout('Email change requested', [`Someone asked to change the email of your ArtQ account to ${to}.`, 'If this was not you, reset your password straight away.']),
    };
  },
  email_changed: (d) => {
    const to = str(d.newEmail, 'newEmail');
    return {
      subject: 'Your ArtQ email address was changed',
      text: `Your ArtQ account now uses ${to}, and you were logged out everywhere. If this was not you, contact us.`,
      html: layout('Email address changed', [`Your ArtQ account now uses ${to}, and you were logged out on every device.`, 'If this was not you, contact us straight away.']),
    };
  },
  account_deleted: () => ({
    subject: 'Your ArtQ account was deleted',
    text: 'Your ArtQ account was deleted and you were logged out everywhere. Your order history is kept for our records; your personal details are removed after 30 days.',
    html: layout('Account deleted', ['Your ArtQ account was deleted and you were logged out on every device.', 'Order records are kept as the law requires; your personal details are removed after 30 days.']),
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
  order_placed: (d) => {
    const n = str(d.orderNumber, 'orderNumber');
    const cod = d.paymentMethod === 'COD';
    const t = totals(d.totals);
    const intro = [`Hi ${str(d.firstName, 'firstName')}, thank you for your order ${n}.`, cod ? `Please keep ${formatINR(t.total)} ready to pay when it arrives (cash or UPI).` : 'Your payment is confirmed.'];
    const outro = [`We usually deliver in ${str(d.estimate, 'estimate')}. We’ll email you again when it ships.`, ...(d.setPasswordLink ? ['Want to track this order and check out faster next time? Set a password for your ArtQ account (the link works for 7 days).'] : [])];
    const action = typeof d.setPasswordLink === 'string' ? { label: 'Set a password', href: d.setPasswordLink } : undefined;
    return {
      subject: `Order ${n} placed`,
      text: orderText(intro, lines(d.lines), t, strs(d.address, 'address'), [...outro, ...(action ? [action.href] : [])]),
      html: orderHtml(`Order ${n} placed`, intro, lines(d.lines), t, strs(d.address, 'address'), outro, action),
    };
  },
  order_confirmed: (d) => {
    const n = str(d.orderNumber, 'orderNumber');
    const intro = [`Hi ${str(d.firstName, 'firstName')}, we’ve confirmed your order ${n} and are getting it ready.`, `We usually deliver in ${str(d.estimate, 'estimate')}. We’ll email you again when it ships.`];
    return { subject: `Order ${n} confirmed`, text: intro.join(' '), html: layout(`Order ${n} confirmed`, intro) };
  },
  order_shipped: (d) => {
    const n = str(d.orderNumber, 'orderNumber');
    const ship = (d.shipment ?? null) as { courier?: string; awb?: string; trackingUrl?: string | null } | null;
    if (!ship?.courier || !ship.awb) throw new TypeError('order_shipped: shipment is required');
    const intro = [`Hi ${str(d.firstName, 'firstName')}, your order ${n} is on its way with ${ship.courier}.`, `Tracking number: ${ship.awb}.`, `It usually arrives in ${str(d.estimate, 'estimate')}. Your tax invoice is available from us on request.`];
    const action = ship.trackingUrl ? { label: 'Track your parcel', href: ship.trackingUrl } : undefined;
    return { subject: `Order ${n} shipped`, text: [...intro, ...(action ? [action.href] : [])].join(' '), html: layout(`Order ${n} shipped`, intro, action) };
  },
  order_delivered: (d) => {
    const n = str(d.orderNumber, 'orderNumber');
    const intro = [`Hi ${str(d.firstName, 'firstName')}, your order ${n} has been delivered.`, 'We hope you enjoy creating with it. If anything is wrong with your order, reply to this email and we’ll help.'];
    return { subject: `Order ${n} delivered`, text: intro.join(' '), html: layout(`Order ${n} delivered`, intro) };
  },
  order_expired: (d) => {
    const n = str(d.orderNumber, 'orderNumber');
    return {
      subject: `Order ${n} was not completed`,
      text: `Your order ${n} wasn’t paid within 30 minutes, so the items were released. If money was taken, it is refunded in full automatically. Your cart is still there if you’d like to try again.`,
      html: layout(`Order ${n} was not completed`, [`Your order ${n} wasn’t paid within 30 minutes, so the items were released.`, 'If money was taken, it is refunded in full automatically.', 'Your cart is still there if you’d like to try again.']),
    };
  },
  order_cancelled: (d) => {
    const n = str(d.orderNumber, 'orderNumber');
    return {
      subject: `Order ${n} cancelled`,
      text: `Your order ${n} was cancelled. If you paid for it, the money is refunded to your original payment method.`,
      html: layout(`Order ${n} cancelled`, [`Your order ${n} was cancelled.`, 'If you paid for it, the money is refunded to your original payment method.']),
    };
  },
  payment_refund_notice: (d) => {
    const n = str(d.orderNumber, 'orderNumber');
    const amount = formatINR(Number(str(d.amount, 'amount')));
    const why = d.reason === 'EXCESS' ? `We received two payments for order ${n}. The extra payment of ${amount} is being refunded.`
      : `Your payment of ${amount} for order ${n} arrived after the order had closed, so it is being refunded in full.`;
    return { subject: `Refund for order ${n}`, text: `${why} Refunds usually reach your account in 5–7 working days.`, html: layout(`Refund for order ${n}`, [why, 'Refunds usually reach your account in 5–7 working days.']) };
  },
  refund_processed: (d) => {
    const n = str(d.orderNumber, 'orderNumber');
    const amount = formatINR(Number(str(d.amount, 'amount')));
    return { subject: `Refund of ${amount} processed`, text: `We’ve refunded ${amount} for order ${n} to your original payment method. It can take 5–7 working days to show in your account.`, html: layout(`Refund of ${amount} processed`, [`We’ve refunded ${amount} for order ${n} to your original payment method.`, 'It can take 5–7 working days to show in your account.']) };
  },
  set_password_link: (d) => {
    const link = str(d.link, 'link');
    return { subject: 'Set a password for your ArtQ account', text: `Set a password to track your orders and check out faster: ${link} (the link works for 7 days).`, html: layout('Set a password', ['Set a password to track your orders and check out faster. The link works for 7 days.'], { label: 'Set a password', href: link }) };
  },
  admin_order_placed: (d) => {
    const n = str(d.orderNumber, 'orderNumber');
    const total = formatINR(Number(str(d.total, 'total')));
    const how = d.paymentMethod === 'COD' ? 'cash on delivery' : 'paid online';
    return { subject: `[ArtQ] New order ${n}: ${total}`, text: `New order ${n}: ${total}, ${how}, ${str(d.itemCount, 'itemCount')} item(s), ${str(d.customer, 'customer')}.`, html: layout(`New order ${n}`, [`Total ${total}, ${how}.`, `${str(d.itemCount, 'itemCount')} item(s) for ${str(d.customer, 'customer')}.`]) };
  },
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
