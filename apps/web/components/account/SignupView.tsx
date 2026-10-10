'use client';
// /signup and /signup/verify (product.md §5.9): name, email, optional phone (contact only), password (8+, a letter and a
// number), marketing consent → a 6-digit code by email → the account is active and signed in. Orders placed as a guest
// with that email join the account; the cart and wishlist of this browser too.
import { signupBody, signupVerifyBody } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { CheckboxField, FormAlert, primaryButton, textLink, TextField } from '../form/fields';
import { PasswordField } from '../form/PasswordField';
import { useApi } from '../shop/ShopProvider';
import { AuthShell, failure, useLeaveWhenSignedIn } from './auth-shared';
import { useAuth } from './AuthProvider';
import { forgetEmail, rememberedEmail, rememberEmail } from './LoginView';

const noSubscribe = () => () => {};
const withNext = (path: string, next: string) => (next === '/account' ? path : `${path}?next=${encodeURIComponent(next)}`);

export function SignupView({ next }: { next: string }) {
  const api = useApi();
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  useLeaveWhenSignedIn(next);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<z.input<typeof signupBody>, unknown, z.output<typeof signupBody>>({
    resolver: zodResolver(signupBody), defaultValues: { name: '', email: '', password: '', marketingOptIn: false },
  });
  const submit = handleSubmit(async (body) => {
    setProblem(null);
    try {
      await api('POST', '/auth/signup', body);
      rememberEmail(body.email);
      router.push(withNext('/signup/verify', next));
    } catch (e) { setProblem(failure(e, setError, ['name', 'email', 'phone', 'password', 'marketingOptIn'])); }
  });
  return (
    <AuthShell title="Create your account" intro={<>Already have one? <Link href={withNext('/login', next)} className={textLink}>Log in</Link></>}>
      <form noValidate onSubmit={(e) => { void submit(e); }} className="space-y-5">
        <TextField id="signup-name" label="Full name" autoComplete="name" error={errors.name?.message} {...register('name')} />
        <TextField id="signup-email" label="Email" type="email" autoComplete="email" inputMode="email" error={errors.email?.message} {...register('email')} />
        <TextField id="signup-phone" label="Mobile number (optional)" type="tel" autoComplete="tel" inputMode="tel" placeholder="+91 98470 12345" error={errors.phone?.message}
          {...register('phone', { setValueAs: (v: string) => (v.replace(/[\s-]/g, '') === '' ? undefined : v.replace(/[\s-]/g, '')) })} />
        <PasswordField id="signup-password" label="Password" autoComplete="new-password" hint="At least 8 characters, with a letter and a number." error={errors.password?.message} {...register('password')} />
        <CheckboxField id="signup-marketing" label="Email me about new arrivals and offers (you can stop any time)" {...register('marketingOptIn')} />
        {problem && <FormAlert>{problem}</FormAlert>}
        <button type="submit" disabled={isSubmitting} className={`${primaryButton} w-full`}>{isSubmitting ? 'Creating…' : 'Create account'}</button>
        <p className="text-xs text-ink-500">We’ll email you a code to confirm your address.</p>
      </form>
    </AuthShell>
  );
}

export function VerifyView({ next }: { next: string }) {
  const { session } = useAuth();
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  const remembered = useSyncExternalStore(noSubscribe, rememberedEmail, () => '');
  const known = remembered !== '';
  const { register, handleSubmit, setError, setValue, formState: { errors, isSubmitting } } = useForm<z.input<typeof signupVerifyBody>, unknown, z.output<typeof signupVerifyBody>>({
    resolver: zodResolver(signupVerifyBody), defaultValues: { email: '', code: '' },
  });
  // The email comes from the signup page in this tab (sessionStorage); another tab or a reload asks for it.
  useEffect(() => { if (remembered) setValue('email', remembered); }, [remembered, setValue]);
  const submit = handleSubmit(async (body) => {
    setProblem(null);
    try {
      await session!.signIn('/auth/signup/verify', body);
      forgetEmail();
      toast('Welcome to ArtQ! Your account is ready.');
      router.replace(next);
    } catch (e) { setProblem(failure(e, setError, ['email', 'code'], { OTP_INVALID: 'code', OTP_EXPIRED: 'code' })); }
  });
  return (
    <AuthShell title="Check your email" intro="Enter the 6-digit code we sent to confirm your email address. It works for 10 minutes.">
      <form noValidate onSubmit={(e) => { void submit(e); }} className="space-y-5">
        <div hidden={known && !errors.email}><TextField id="verify-email" label="Email" type="email" autoComplete="email" error={errors.email?.message} {...register('email')} /></div>
        <TextField id="verify-code" label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} error={errors.code?.message} {...register('code')} />
        {problem && <FormAlert>{problem}</FormAlert>}
        <button type="submit" disabled={isSubmitting} className={`${primaryButton} w-full`}>{isSubmitting ? 'Checking…' : 'Confirm email'}</button>
        <p className="text-sm text-ink-700">No code? Check your spam folder, or <Link href={withNext('/signup', next)} className={textLink}>sign up again</Link> to get a new one.</p>
      </form>
    </AuthShell>
  );
}
