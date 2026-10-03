'use client';
// Pieces shared by the sign-in and account pages (task 4.2): the page frame, error mapping, redirects.
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from '../../lib/api';
import { applyServerErrors } from '../form/fields';
import { errorText } from '../shop/ShopProvider';
import { useAuth } from './AuthProvider';

export function AuthShell({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[460px] px-4 py-10 md:py-16">
      <h1 className="font-display text-[28px] font-semibold text-ink-900 md:text-[34px]">{title}</h1>
      {intro && <div className="mt-2 text-ink-700">{intro}</div>}
      <div className="mt-8">{children}</div>
    </div>
  );
}

/**
 * What a failed request shows: VALIDATION_ERROR details go on their fields (null when all of them landed), `codeFields`
 * puts other codes on a field (e.g. OTP_INVALID on the code), everything else is a form-level message.
 */
export function failure<T extends FieldValues>(e: unknown, setError: UseFormSetError<T>, fields: readonly Path<T>[], codeFields: Partial<Record<string, Path<T>>> = {}): string | null {
  if (applyServerErrors(e, setError, fields)) return null;
  if (e instanceof ApiError) {
    const field = codeFields[e.code];
    if (field) { setError(field, { type: 'server', message: e.message }, { shouldFocus: true }); return null; }
    if (e.code === 'VALIDATION_ERROR') return 'Please check the highlighted fields.';
    if (e.code === 'ACCOUNT_LOCKED') {
      const s = Number((e.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds) || 900;
      return `Too many wrong passwords. Try again in ${Math.ceil(s / 60)} minute${s > 60 ? 's' : ''}, or log in with an email code.`;
    }
  }
  return errorText(e);
}

/** Sign-in pages: a signed-in visitor goes straight on to `next`. */
export function useLeaveWhenSignedIn(next: string) {
  const { status } = useAuth();
  const router = useRouter();
  useEffect(() => { if (status === 'signed-in') router.replace(next); }, [status, next, router]);
}

/** Set while an account page sends the visitor somewhere on purpose (logout, password change…). */
let leaving = false;
/** Leaves the account area on purpose, then ends the session: the sign-in guard below does not send them to login. */
export function leaveAccount(router: ReturnType<typeof useRouter>, to: string, end: () => unknown) {
  leaving = true;
  router.push(to);
  return end();
}

/** Account pages: a visitor who is not signed in (or is logged out in another tab) goes to login and comes back after. */
export function useRequireSignIn(here: string) {
  const { status, user } = useAuth();
  const router = useRouter();
  useEffect(() => { leaving = false; }, []);
  useEffect(() => { if (status === 'anonymous' && !leaving) router.replace(`/login?next=${encodeURIComponent(here)}`); }, [status, here, router]);
  return status === 'signed-in' ? user : null;
}

export function Loading({ label = 'Loading your account…' }: { label?: string }) {
  return <p role="status" className="py-16 text-center text-ink-700">{label}</p>;
}
