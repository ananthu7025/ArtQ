'use client';
// /account (product.md §5.10): profile (phone is for delivery contact only), email change (a code to the new address),
// password, delete account. Changing the email or password, or deleting the account, logs out every device.
import { changePasswordBody, deleteAccountBody, emailChangeBody, emailVerifyBody, profileBody } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { withRepeat } from '../../lib/form-schemas';
import type { Customer } from '../../lib/session';
import { CheckboxField, dangerButton, FormAlert, primaryButton, secondaryButton, textLink, TextField } from '../form/fields';
import { PasswordField } from '../form/PasswordField';
import { useApi } from '../shop/ShopProvider';
import { failure, leaveAccount, Loading, useRequireSignIn } from './auth-shared';
import { useAuth } from './AuthProvider';

const SECTIONS = [{ href: '/account', label: 'Profile & security' }, { href: '/account/addresses', label: 'Addresses' }, { href: '/wishlist', label: 'Wishlist' }] as const;

export function AccountShell({ title, children }: { title: string; children: ReactNode }) {
  const { session, user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-8 md:px-6 md:py-12">
      <p className="text-sm text-ink-700">Hello{user?.name ? `, ${user.name.split(' ')[0]}` : ''}</p>
      <h1 className="font-display text-[28px] font-semibold text-ink-900 md:text-[34px]">{title}</h1>
      <div className="mt-6 grid gap-8 md:grid-cols-[220px_1fr]">
        <nav aria-label="Your account">
          <ul className="flex gap-2 overflow-x-auto md:flex-col md:gap-1">
            {SECTIONS.map((s) => (
              <li key={s.href} className="shrink-0">
                <Link href={s.href} aria-current={pathname === s.href ? 'page' : undefined}
                  className="flex h-11 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium text-ink-900 hover:bg-surface-100 aria-[current=page]:bg-surface-100 aria-[current=page]:text-brand-700">{s.label}</Link>
              </li>
            ))}
            <li className="shrink-0">
              <button type="button" onClick={() => { void Promise.resolve(leaveAccount(router, '/', () => session?.logout())).then(() => toast('You’re logged out.')); }}
                className="flex h-11 w-full items-center whitespace-nowrap rounded-md px-3 text-left text-sm font-medium text-ink-700 hover:bg-surface-100">Log out</button>
            </li>
          </ul>
        </nav>
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </div>
  );
}

export function Panel({ title, id, children, description }: { title: string; id: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-surface-200 p-5 md:p-6">
      <h2 id={id} className="text-lg font-semibold text-ink-900">{title}</h2>
      {description && <div className="mt-1 text-sm text-ink-700">{description}</div>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function AccountView() {
  const user = useRequireSignIn('/account');
  if (!user) return <Loading />;
  return (
    <AccountShell title="Profile & security">
      <ProfileForm user={user} />
      <EmailChange user={user} />
      <PasswordChange />
      <DeleteAccount />
    </AccountShell>
  );
}

function ProfileForm({ user }: { user: Customer }) {
  const api = useApi();
  const { session } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<z.input<typeof profileBody>, unknown, z.output<typeof profileBody>>({
    resolver: zodResolver(profileBody), defaultValues: { name: user.name ?? '', phone: user.phone ?? '', marketingOptIn: user.marketingOptIn },
  });
  const submit = handleSubmit(async (body) => {
    setProblem(null);
    try {
      const r = await api<{ user: Customer }>('PATCH', '/me', body);
      session?.updateUser(r.user);
      toast('Profile saved');
    } catch (e) { setProblem(failure(e, setError, ['name', 'phone', 'marketingOptIn'])); }
  });
  return (
    <Panel title="Profile" id="profile-heading">
      <form noValidate onSubmit={(e) => { void submit(e); }} className="grid gap-5 md:grid-cols-2">
        <TextField id="profile-name" label="Full name" autoComplete="name" error={errors.name?.message} {...register('name')} />
        <TextField id="profile-phone" label="Mobile number (for delivery updates)" type="tel" autoComplete="tel" inputMode="tel" error={errors.phone?.message}
          {...register('phone', { setValueAs: (v: string | null) => (v ?? '').replace(/[\s-]/g, '') })} />
        <div className="md:col-span-2"><CheckboxField id="profile-marketing" label="Email me about new arrivals and offers" {...register('marketingOptIn')} /></div>
        {problem && <div className="md:col-span-2"><FormAlert>{problem}</FormAlert></div>}
        <div className="md:col-span-2"><button type="submit" disabled={isSubmitting} className={primaryButton}>{isSubmitting ? 'Saving…' : 'Save profile'}</button></div>
      </form>
    </Panel>
  );
}

function EmailChange({ user }: { user: Customer }) {
  const api = useApi();
  const { session } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const first = useForm<z.input<typeof emailChangeBody>, unknown, z.output<typeof emailChangeBody>>({ resolver: zodResolver(emailChangeBody), defaultValues: { newEmail: '', password: '' } });
  const second = useForm<z.input<typeof emailVerifyBody>, unknown, z.output<typeof emailVerifyBody>>({ resolver: zodResolver(emailVerifyBody), defaultValues: { code: '' } });
  const request = first.handleSubmit(async (body) => {
    setProblem(null);
    try { const r = await api<{ otpSentTo: string }>('POST', '/me/email/change', body); setSentTo(r.otpSentTo); }
    catch (e) { setProblem(failure(e, first.setError, ['newEmail', 'password'])); }
  });
  const verify = second.handleSubmit(async (body) => {
    setProblem(null);
    try {
      const r = await api<{ email: string }>('POST', '/me/email/verify', body);
      leaveAccount(router, '/login', () => session?.ended());
      toast(`Email changed to ${r.email}. Please log in again.`);
    } catch (e) { setProblem(failure(e, second.setError, ['code'], { OTP_INVALID: 'code', OTP_EXPIRED: 'code' })); }
  });
  return (
    <Panel title="Email address" id="email-heading" description={<>You log in with <strong className="text-ink-900">{user.email}</strong>.</>}>
      {!open && <button type="button" className={secondaryButton} onClick={() => setOpen(true)}>Change email</button>}
      {open && !sentTo && (
        <form noValidate onSubmit={(e) => { void request(e); }} className="grid gap-5 md:grid-cols-2">
          <TextField id="email-new" label="New email" type="email" autoComplete="email" error={first.formState.errors.newEmail?.message} {...first.register('newEmail')} />
          <PasswordField id="email-password" label="Your password" autoComplete="current-password" error={first.formState.errors.password?.message} {...first.register('password')} />
          {problem && <div className="md:col-span-2"><FormAlert>{problem}</FormAlert></div>}
          <div className="flex flex-wrap gap-3 md:col-span-2">
            <button type="submit" disabled={first.formState.isSubmitting} className={primaryButton}>{first.formState.isSubmitting ? 'Sending…' : 'Send code'}</button>
            <button type="button" className={secondaryButton} onClick={() => { setOpen(false); first.reset(); setProblem(null); }}>Cancel</button>
          </div>
        </form>
      )}
      {sentTo && (
        <form noValidate onSubmit={(e) => { void verify(e); }} className="space-y-5">
          <p role="status" className="text-sm text-ink-700">We sent a 6-digit code to <strong className="text-ink-900">{sentTo}</strong>. After the change you’ll log in again on every device.</p>
          <div className="max-w-xs"><TextField id="email-code" label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} error={second.formState.errors.code?.message} {...second.register('code')} /></div>
          {problem && <FormAlert>{problem}</FormAlert>}
          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={second.formState.isSubmitting} className={primaryButton}>{second.formState.isSubmitting ? 'Checking…' : 'Change email'}</button>
            <button type="button" className={secondaryButton} onClick={() => { setSentTo(null); setOpen(false); first.reset(); second.reset(); setProblem(null); }}>Cancel</button>
          </div>
        </form>
      )}
    </Panel>
  );
}

/** The shared rule plus a client-only "type it again" field. */
export const changePasswordForm = withRepeat(changePasswordBody, 'newPassword');

function PasswordChange() {
  const api = useApi();
  const { session } = useAuth();
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<z.input<typeof changePasswordForm>, unknown, z.output<typeof changePasswordForm>>({
    resolver: zodResolver(changePasswordForm), defaultValues: { currentPassword: '', newPassword: '', repeat: '' },
  });
  const submit = handleSubmit(async ({ currentPassword, newPassword }) => {
    setProblem(null);
    try {
      await api('POST', '/me/password', { currentPassword, newPassword });
      leaveAccount(router, '/login', () => session?.ended());
      toast('Password changed. Please log in with your new password.');
    } catch (e) { setProblem(failure(e, setError, ['currentPassword', 'newPassword'])); }
  });
  return (
    <Panel title="Password" id="password-heading" description="Changing it logs you out on every device.">
      <form noValidate onSubmit={(e) => { void submit(e); }} className="grid gap-5 md:grid-cols-2">
        <div className="md:col-span-2 md:max-w-[calc(50%-10px)]"><PasswordField id="pw-current" label="Current password" autoComplete="current-password" error={errors.currentPassword?.message} {...register('currentPassword')} /></div>
        <PasswordField id="pw-new" label="New password" autoComplete="new-password" hint="At least 8 characters, with a letter and a number." error={errors.newPassword?.message} {...register('newPassword')} />
        <PasswordField id="pw-repeat" label="Type it again" autoComplete="new-password" error={errors.repeat?.message} {...register('repeat')} />
        {problem && <div className="md:col-span-2"><FormAlert>{problem}</FormAlert></div>}
        <p className="text-sm md:col-span-2">Forgot it? <Link href="/forgot-password" className={textLink}>Reset by email</Link></p>
        <div className="md:col-span-2"><button type="submit" disabled={isSubmitting} className={primaryButton}>{isSubmitting ? 'Saving…' : 'Change password'}</button></div>
      </form>
    </Panel>
  );
}

function DeleteAccount() {
  const api = useApi();
  const { session } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, reset, formState: { errors, isSubmitting } } = useForm<z.input<typeof deleteAccountBody>, unknown, z.output<typeof deleteAccountBody>>({
    resolver: zodResolver(deleteAccountBody), defaultValues: { password: '', confirm: false as unknown as true },
  });
  const submit = handleSubmit(async (body) => {
    setProblem(null);
    try {
      await api('DELETE', '/me', body);
      leaveAccount(router, '/', () => session?.ended());
      toast('Your account was deleted.');
    } catch (e) { setProblem(failure(e, setError, ['password', 'confirm'])); }
  });
  return (
    <Panel title="Delete account" id="delete-heading" description="Your saved addresses and wishlist are removed and you can’t log in again. Order records are kept as the law requires; your personal details are erased after 30 days.">
      {!open && <button type="button" className={secondaryButton} onClick={() => setOpen(true)}>Delete my account</button>}
      {open && (
        <form noValidate onSubmit={(e) => { void submit(e); }} className="space-y-5">
          <div className="md:max-w-[calc(50%-10px)]"><PasswordField id="delete-password" label="Your password" autoComplete="current-password" error={errors.password?.message} {...register('password')} /></div>
          <CheckboxField id="delete-confirm" label="I understand my account will be deleted" error={errors.confirm?.message} {...register('confirm')} />
          {problem && <FormAlert>{problem}</FormAlert>}
          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={isSubmitting} className={dangerButton}>{isSubmitting ? 'Deleting…' : 'Delete account'}</button>
            <button type="button" className={secondaryButton} onClick={() => { setOpen(false); reset(); setProblem(null); }}>Keep my account</button>
          </div>
        </form>
      )}
    </Panel>
  );
}
