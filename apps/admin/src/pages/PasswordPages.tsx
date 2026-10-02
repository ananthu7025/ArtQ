// Public admin password pages: "Forgot password" (emails a 30-minute link to staff accounts) and the page that invite
// and reset links open (`/reset-password?token=…`). Staff passwords need at least 12 characters (architecture.md §5).
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
import { z } from 'zod';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

export const STAFF_PASSWORD_MIN = 12;
const input = 'mt-1 h-11 w-full rounded-md border border-border-input px-3 text-ink-900';
const primary = 'h-11 w-full rounded-md bg-brand-700 font-semibold text-white disabled:opacity-80';

function Card({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-50 p-4">
      <div className="w-full max-w-sm rounded-lg border border-surface-200 bg-white p-8 shadow-sm">
        <h1 className="font-display text-2xl text-ink-900">{title}</h1>
        <p className="mt-1 text-sm text-ink-700">{intro}</p>
        {children}
      </div>
    </main>
  );
}

const failure = (e: unknown) => (e instanceof ApiError && e.code === 'RATE_LIMITED' ? 'Too many requests from this network. Wait a few minutes and try again.' : e instanceof Error ? e.message : 'Something went wrong. Try again.');

export function ForgotPasswordPage() {
  const { api } = useAuth();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<{ email: string }>({ resolver: zodResolver(z.object({ email: z.email('Enter a valid email address') })) });
  const onSubmit = handleSubmit(async ({ email }) => {
    setError(null);
    try { await api.forgotPassword(email); setSentTo(email); } catch (e) { setError(failure(e)); }
  });

  if (sentTo) {
    return (
      <Card title="Check your email" intro={`If ${sentTo} belongs to a staff account, a link to choose a new password is on its way. It expires in 30 minutes.`}>
        <Link to="/login" className="mt-6 inline-block font-medium text-brand-700 underline">Back to log in</Link>
      </Card>
    );
  }
  return (
    <Card title="Forgot your password?" intro="Enter your staff email and we'll send you a link to choose a new one.">
      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-ink-900">Email</label>
          <input id="email" type="email" autoComplete="username" {...register('email')} aria-invalid={errors.email ? true : undefined} aria-describedby={errors.email ? 'email-error' : undefined} className={input} />
          {errors.email && <p id="email-error" className="mt-1 text-sm text-danger-700">{errors.email.message}</p>}
        </div>
        {error && <p role="alert" className="rounded-md bg-[#fee2e2] px-3 py-2 text-sm text-danger-700">{error}</p>}
        <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined} className={primary}>{isSubmitting ? 'Sending…' : 'Send link'}</button>
        <Link to="/login" className="block text-center text-sm font-medium text-brand-700 underline">Back to log in</Link>
      </form>
    </Card>
  );
}

const resetSchema = z.object({
  password: z.string().min(STAFF_PASSWORD_MIN, `Use at least ${STAFF_PASSWORD_MIN} characters`).max(128, 'Use at most 128 characters'),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { message: 'The passwords do not match', path: ['confirm'] });

export function ResetPasswordPage() {
  const { api } = useAuth();
  const token = useSearchParams()[0].get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<z.infer<typeof resetSchema>>({ resolver: zodResolver(resetSchema) });
  const onSubmit = handleSubmit(async ({ password }) => {
    setError(null);
    try { await api.resetPassword(token, password); setDone(true); }
    catch (e) { setError(e instanceof ApiError && e.code === 'TOKEN_INVALID' ? 'This link has expired or was already used. Ask for a new one.' : failure(e)); }
  });

  if (!token) {
    return (
      <Card title="Link incomplete" intro="This page needs the link from your email. Open the link again, or ask for a new one.">
        <Link to="/forgot-password" className="mt-6 inline-block font-medium text-brand-700 underline">Get a new link</Link>
      </Card>
    );
  }
  if (done) {
    return (
      <Card title="Password set" intro="You can now log in with your new password. Any other devices were logged out.">
        <Link to="/login" className="mt-6 inline-block h-11 w-full rounded-md bg-brand-700 py-2.5 text-center font-semibold text-white">Log in</Link>
      </Card>
    );
  }
  return (
    <Card title="Choose a password" intro={`Use at least ${STAFF_PASSWORD_MIN} characters. A short phrase is easy to remember and hard to guess.`}>
      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <div>
          <label htmlFor="new-password" className="block text-sm font-medium text-ink-900">New password</label>
          <input id="new-password" type="password" autoComplete="new-password" {...register('password')} aria-invalid={errors.password ? true : undefined} aria-describedby={errors.password ? 'new-password-error' : undefined} className={input} />
          {errors.password && <p id="new-password-error" className="mt-1 text-sm text-danger-700">{errors.password.message}</p>}
        </div>
        <div>
          <label htmlFor="confirm-password" className="block text-sm font-medium text-ink-900">Repeat the password</label>
          <input id="confirm-password" type="password" autoComplete="new-password" {...register('confirm')} aria-invalid={errors.confirm ? true : undefined} aria-describedby={errors.confirm ? 'confirm-password-error' : undefined} className={input} />
          {errors.confirm && <p id="confirm-password-error" className="mt-1 text-sm text-danger-700">{errors.confirm.message}</p>}
        </div>
        {error && (
          <p role="alert" className="rounded-md bg-[#fee2e2] px-3 py-2 text-sm text-danger-700">
            {error} {error.startsWith('This link') && <Link to="/forgot-password" className="font-medium underline">Get a new link</Link>}
          </p>
        )}
        <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined} className={primary}>{isSubmitting ? 'Saving…' : 'Set password'}</button>
      </form>
    </Card>
  );
}
