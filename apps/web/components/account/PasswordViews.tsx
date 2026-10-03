'use client';
// /forgot-password → emailed 30-minute link → /reset-password?token= (every session ends), and /set-password?token=
// from the post-checkout email (creates the account and signs in). product.md §5.9.
import { forgotPasswordBody, resetPasswordBody } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm, type UseFormSetError } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { withRepeat } from '../../lib/form-schemas';
import { ApiError } from '../../lib/api';
import { FormAlert, primaryButton, textLink, TextField } from '../form/fields';
import { PasswordField } from '../form/PasswordField';
import { useApi } from '../shop/ShopProvider';
import { AuthShell, failure } from './auth-shared';
import { useAuth } from './AuthProvider';

/** The shared password rule plus a client-only "type it again" field. */
export const newPasswordForm = withRepeat(resetPasswordBody.pick({ password: true }), 'password');
type NewPassword = z.input<typeof newPasswordForm>;

export function ForgotView() {
  const api = useApi();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<z.input<typeof forgotPasswordBody>, unknown, z.output<typeof forgotPasswordBody>>({ resolver: zodResolver(forgotPasswordBody), defaultValues: { email: '' } });
  const submit = handleSubmit(async (body) => {
    setProblem(null);
    try { await api('POST', '/auth/password/forgot', body); setSentTo(body.email); } catch (e) { setProblem(failure(e, setError, ['email'])); }
  });
  if (sentTo) {
    return (
      <AuthShell title="Check your email">
        <p role="status" className="text-ink-900">If <strong>{sentTo}</strong> has an ArtQ account, we’ve emailed a link to choose a new password. The link works for 30 minutes.</p>
        <p className="mt-6 text-sm text-ink-700">Nothing arrived? Check spam, or <button type="button" className={textLink} onClick={() => setSentTo(null)}>try again</button>. You can also <Link href="/login" className={textLink}>log in with an email code</Link>.</p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Forgot your password?" intro="Enter your email and we’ll send you a link to choose a new one.">
      <form noValidate onSubmit={(e) => { void submit(e); }} className="space-y-5">
        <TextField id="forgot-email" label="Email" type="email" autoComplete="email" inputMode="email" error={errors.email?.message} {...register('email')} />
        {problem && <FormAlert>{problem}</FormAlert>}
        <button type="submit" disabled={isSubmitting} className={`${primaryButton} w-full`}>{isSubmitting ? 'Sending…' : 'Email me a link'}</button>
        <p className="text-sm"><Link href="/login" className={textLink}>Back to log in</Link></p>
      </form>
    </AuthShell>
  );
}

function NewPasswordForm({ id, cta, busy, onSubmit }: { id: string; cta: string; busy: string; onSubmit: (password: string, setError: UseFormSetError<NewPassword>) => Promise<string | null> }) {
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<NewPassword, unknown, z.output<typeof newPasswordForm>>({ resolver: zodResolver(newPasswordForm), defaultValues: { password: '', repeat: '' } });
  const submit = handleSubmit(async ({ password }) => { setProblem(null); setProblem(await onSubmit(password, setError)); });
  return (
    <form noValidate onSubmit={(e) => { void submit(e); }} className="space-y-5">
      <PasswordField id={`${id}-password`} label="New password" autoComplete="new-password" hint="At least 8 characters, with a letter and a number." error={errors.password?.message} {...register('password')} />
      <PasswordField id={`${id}-repeat`} label="Type it again" autoComplete="new-password" error={errors.repeat?.message} {...register('repeat')} />
      {problem && <FormAlert>{problem}</FormAlert>}
      <button type="submit" disabled={isSubmitting} className={`${primaryButton} w-full`}>{isSubmitting ? busy : cta}</button>
    </form>
  );
}

const linkProblem = (e: unknown, again: string) => (e instanceof ApiError && e.code === 'TOKEN_INVALID' ? `This link has expired or was already used. ${again}` : null);

function MissingLink({ title, again }: { title: string; again: React.ReactNode }) {
  return <AuthShell title={title}><FormAlert>This link is incomplete. Open the link from your email again, or {again}.</FormAlert></AuthShell>;
}

export function ResetView({ token }: { token: string | null }) {
  const api = useApi();
  const [done, setDone] = useState(false);
  if (!token) return <MissingLink title="Choose a new password" again={<Link href="/forgot-password" className="underline">ask for a new link</Link>} />;
  if (done) {
    return (
      <AuthShell title="Password changed">
        <p role="status" className="text-ink-900">Your new password is set, and you’ve been logged out on every device.</p>
        <Link href="/login" className={`${primaryButton} mt-6 w-full`}>Log in</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Choose a new password">
      <NewPasswordForm id="reset" cta="Save password" busy="Saving…" onSubmit={async (password, setError) => {
        try { await api('POST', '/auth/password/reset', { token, password }); setDone(true); return null; } catch (e) {
          return linkProblem(e, 'Ask for a new one from “Forgot password”.') ?? failure(e, setError, ['password']);
        }
      }} />
    </AuthShell>
  );
}

export function SetPasswordView({ token }: { token: string | null }) {
  const { session } = useAuth();
  const router = useRouter();
  if (!token) return <MissingLink title="Set your password" again={<Link href="/signup" className="underline">create an account</Link>} />;
  return (
    <AuthShell title="Set your password" intro="Choose a password to finish your ArtQ account. Your orders with this email will be in it.">
      <NewPasswordForm id="set" cta="Create account" busy="Creating…" onSubmit={async (password, setError) => {
        try {
          await session!.signIn('/auth/set-password', { token, password });
          toast('Your account is ready.');
          router.replace('/account');
          return null;
        } catch (e) {
          if (e instanceof ApiError && e.code === 'ACCOUNT_EXISTS') return 'This email already has an account. Log in, or use “Forgot password” to choose a new password.';
          return linkProblem(e, 'Create an account with the same email instead.') ?? failure(e, setError, ['password']);
        }
      }} />
    </AuthShell>
  );
}
