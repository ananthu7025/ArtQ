import { adminLoginBody } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { applyServerErrors, FormAlert, TextField } from '../components/form';

function loginError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_CREDENTIALS') return 'Email or password is incorrect.';
    if (e.code === 'ACCOUNT_LOCKED') {
      const s = (e.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      return `Too many failed attempts. Try again in ${s ? Math.ceil(s / 60) : 15} minutes.`;
    }
    if (e.code === 'ACCOUNT_BLOCKED') return 'This account is disabled. Contact the store owner.';
    if (e.code === 'RATE_LIMITED') return 'Too many attempts from this network. Wait a minute and try again.';
    return e.message;
  }
  return 'Something went wrong. Try again.';
}

export function LoginPage() {
  const { state, login } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/dashboard';
  const [error, setError] = useState<string | null>(null);
  // The same schema the API validates with (CLAUDE.md "Validation rule").
  const { register, handleSubmit, setError: setFieldError, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(adminLoginBody) });

  if (state.status === 'authenticated') return <Navigate to={from} replace />;

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    try { await login(v.email, v.password); navigate(from, { replace: true }); }
    catch (e) { if (!applyServerErrors(e, setFieldError, ['email', 'password'])) setError(loginError(e)); }
  });

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-50 p-4">
      <div className="w-full max-w-sm rounded-lg border border-surface-200 bg-white p-8 shadow-sm">
        <h1 className="font-display text-2xl text-ink-900">ArtQ Admin</h1>
        <p className="mt-1 text-sm text-ink-700">Log in with your staff account.</p>
        <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
          <TextField id="email" label="Email" type="email" autoComplete="username" {...register('email')} error={errors.email?.message} />
          <TextField id="password" label="Password" type="password" autoComplete="current-password" {...register('password')} error={errors.password?.message} />
          {error && <FormAlert>{error}</FormAlert>}
          <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined} className="h-11 w-full rounded-md bg-brand-700 font-semibold text-white disabled:opacity-80">
            {isSubmitting ? 'Logging in…' : 'Log in'}
          </button>
          <Link to="/forgot-password" className="block text-center text-sm font-medium text-brand-700 underline">Forgot your password?</Link>
        </form>
      </div>
    </main>
  );
}
