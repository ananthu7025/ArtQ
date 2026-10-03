'use client';
// /login (product.md §5.9): email + password, or a 6-digit code sent by email. 5 wrong passwords lock the account for
// 15 minutes (the code login still works). After signing in: back to `next`, else the account page.
import { loginBody, otpRequestBody, otpVerifyBody } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ApiError } from '../../lib/api';
import { FormAlert, primaryButton, textLink, TextField } from '../form/fields';
import { PasswordField } from '../form/PasswordField';
import { useApi } from '../shop/ShopProvider';
import { AuthShell, failure, useLeaveWhenSignedIn } from './auth-shared';
import { useAuth } from './AuthProvider';

type Tab = 'password' | 'code';
const emailStep = otpRequestBody.pick({ email: true });
const codeStep = otpVerifyBody.pick({ code: true });

export function LoginView({ next }: { next: string }) {
  const [tab, setTab] = useState<Tab>('password');
  const [email, setEmail] = useState('');
  useLeaveWhenSignedIn(next);
  const tabs = useRef<Record<Tab, HTMLButtonElement | null>>({ password: null, code: null });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const to: Tab = e.key === 'Home' ? 'password' : e.key === 'End' ? 'code' : tab === 'password' ? 'code' : 'password';
    setTab(to);
    tabs.current[to]?.focus();
  };
  const tabClass = 'h-11 flex-1 rounded-md text-sm font-semibold aria-selected:bg-white aria-selected:text-ink-900 aria-selected:shadow-sm text-ink-700';
  return (
    <AuthShell title="Log in" intro={<>New to ArtQ? <Link href={`/signup${next !== '/account' ? `?next=${encodeURIComponent(next)}` : ''}`} className={textLink}>Create an account</Link></>}>
      <div role="tablist" aria-label="How to log in" onKeyDown={onKey} className="mb-6 flex gap-1 rounded-lg bg-surface-100 p-1">
        <button ref={(el) => { tabs.current.password = el; }} type="button" role="tab" id="tab-password" aria-controls="panel-password" aria-selected={tab === 'password'} tabIndex={tab === 'password' ? 0 : -1} onClick={() => setTab('password')} className={tabClass}>Password</button>
        <button ref={(el) => { tabs.current.code = el; }} type="button" role="tab" id="tab-code" aria-controls="panel-code" aria-selected={tab === 'code'} tabIndex={tab === 'code' ? 0 : -1} onClick={() => setTab('code')} className={tabClass}>Email code</button>
      </div>
      <div role="tabpanel" id="panel-password" aria-labelledby="tab-password" hidden={tab !== 'password'}>
        {tab === 'password' && <PasswordLogin next={next} email={email} onEmail={setEmail} />}
      </div>
      <div role="tabpanel" id="panel-code" aria-labelledby="tab-code" hidden={tab !== 'code'}>
        {tab === 'code' && <CodeLogin next={next} email={email} onEmail={setEmail} />}
      </div>
    </AuthShell>
  );
}

function PasswordLogin({ next, email, onEmail }: { next: string; email: string; onEmail: (e: string) => void }) {
  const { session } = useAuth();
  const router = useRouter();
  const [problem, setProblem] = useState<{ text: string; unverified?: boolean } | null>(null);
  const { register, handleSubmit, setError, getValues, formState: { errors, isSubmitting } } = useForm<z.input<typeof loginBody>, unknown, z.output<typeof loginBody>>({ resolver: zodResolver(loginBody), defaultValues: { email, password: '' } });
  useEffect(() => () => onEmail(getValues('email')), [getValues, onEmail]);
  const submit = handleSubmit(async (body) => {
    setProblem(null);
    try {
      await session!.signIn('/auth/login', body);
      router.replace(next);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NOT_VERIFIED') { setProblem({ text: 'Verify your email to finish creating your account.', unverified: true }); return; }
      const text = failure(e, setError, ['email', 'password']);
      if (text) setProblem({ text });
    }
  });
  return (
    <form noValidate onSubmit={(e) => { void submit(e); }} className="space-y-5">
      <TextField id="login-email" label="Email" type="email" autoComplete="email" inputMode="email" error={errors.email?.message} {...register('email')} />
      <div>
        <PasswordField id="login-password" label="Password" autoComplete="current-password" error={errors.password?.message} {...register('password')} />
        <p className="mt-2 text-right text-sm"><Link href="/forgot-password" className={textLink}>Forgot password?</Link></p>
      </div>
      {problem && (
        <FormAlert>{problem.text}{problem.unverified && <> <Link href="/signup/verify" className="underline" onClick={() => rememberEmail(getValues('email'))}>Enter your code</Link></>}</FormAlert>
      )}
      <button type="submit" disabled={isSubmitting} className={`${primaryButton} w-full`}>{isSubmitting ? 'Logging in…' : 'Log in'}</button>
    </form>
  );
}

function CodeLogin({ next, email, onEmail }: { next: string; email: string; onEmail: (e: string) => void }) {
  const { session } = useAuth();
  const api = useApi();
  const router = useRouter();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const first = useForm<z.input<typeof emailStep>, unknown, z.output<typeof emailStep>>({ resolver: zodResolver(emailStep), defaultValues: { email } });
  const second = useForm<z.input<typeof codeStep>, unknown, z.output<typeof codeStep>>({ resolver: zodResolver(codeStep), defaultValues: { code: '' } });
  const send = async (to: string) => {
    setProblem(null);
    try {
      const r = await api<{ sent: true; resendAfter: number }>('POST', '/auth/otp/request', { email: to, purpose: 'LOGIN' });
      setSentTo(to); onEmail(to); setWait(r.resendAfter || 30);
    } catch (e) { setProblem(failure(e, first.setError, ['email'])); }
  };
  const request = first.handleSubmit(({ email: to }) => send(to));
  const verify = second.handleSubmit(async ({ code }) => {
    setProblem(null);
    try {
      await session!.signIn('/auth/otp/verify', { email: sentTo, purpose: 'LOGIN', code });
      router.replace(next);
    } catch (e) { setProblem(failure(e, second.setError, ['code'], { OTP_INVALID: 'code', OTP_EXPIRED: 'code' })); }
  });

  if (!sentTo) {
    return (
      <form noValidate onSubmit={(e) => { void request(e); }} className="space-y-5">
        <p className="text-sm text-ink-700">We’ll email you a 6-digit code. No password needed.</p>
        <TextField id="code-email" label="Email" type="email" autoComplete="email" inputMode="email" error={first.formState.errors.email?.message} {...first.register('email')} />
        {problem && <FormAlert>{problem}</FormAlert>}
        <button type="submit" disabled={first.formState.isSubmitting} className={`${primaryButton} w-full`}>{first.formState.isSubmitting ? 'Sending…' : 'Email me a code'}</button>
      </form>
    );
  }
  return (
    <form noValidate onSubmit={(e) => { void verify(e); }} className="space-y-5">
      <p role="status" className="text-sm text-ink-700">If <strong className="text-ink-900">{sentTo}</strong> has an account, a code is on its way. It works for 10 minutes.</p>
      <TextField id="login-code" label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} error={second.formState.errors.code?.message} {...second.register('code')} />
      {problem && <FormAlert>{problem}</FormAlert>}
      <button type="submit" disabled={second.formState.isSubmitting} className={`${primaryButton} w-full`}>{second.formState.isSubmitting ? 'Checking…' : 'Log in'}</button>
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <button type="button" className={textLink} onClick={() => { setSentTo(null); second.reset(); setProblem(null); }}>Use another email</button>
        {wait > 0
          ? <span className="text-ink-500">Send again in {wait} s</span>
          : <button type="button" className={textLink} onClick={() => { void send(sentTo); }}>Send a new code</button>}
      </div>
    </form>
  );
}

/** The signup and verify pages pass the email through this tab's storage, never through the URL. */
const VERIFY_KEY = 'aq_verify_email';
export function rememberEmail(email: string) { try { window.sessionStorage.setItem(VERIFY_KEY, email); } catch { /* storage blocked: the verify page asks */ } }
export function rememberedEmail(): string { try { return window.sessionStorage.getItem(VERIFY_KEY) ?? ''; } catch { return ''; } }
export function forgetEmail() { try { window.sessionStorage.removeItem(VERIFY_KEY); } catch { /* ignore */ } }
