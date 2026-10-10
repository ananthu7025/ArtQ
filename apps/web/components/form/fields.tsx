// Validation rule (CLAUDE.md): an invalid field gets aria-invalid (red border, globals.css) and its message directly
// under it in red, linked with aria-describedby; server VALIDATION_ERROR details land on the same fields.
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from '../../lib/api';

export type FieldProps = { id: string; label: string; error?: string | undefined; tone?: 'light' | 'dark'; hideLabel?: boolean; inputClassName?: string; ref?: React.Ref<HTMLInputElement> };

export function TextField({ id, label, error, tone = 'light', hideLabel, inputClassName, className, ...input }: FieldProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>) {
  const dark = tone === 'dark';
  return (
    <div className={className}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : `block text-[13px] font-medium ${dark ? 'text-white' : 'text-ink-900'}`}>{label}</label>
      <input id={id} {...input} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
        className={inputClassName ?? 'mt-1 block h-12 w-full rounded-md border border-border-input bg-white px-3 text-base text-ink-900 md:h-11'} />
      {error && <p id={`${id}-error`} className={`mt-1 text-sm ${dark ? 'text-danger-300' : 'text-danger-700'}`}>{error}</p>}
    </div>
  );
}

export function FormAlert({ children, tone = 'light' }: { children: ReactNode; tone?: 'light' | 'dark' }) {
  return <p role="alert" className={tone === 'dark' ? 'text-sm text-danger-300' : 'rounded-md bg-[#fee2e2] px-3 py-2 text-sm text-danger-700'}>{children}</p>;
}

/** Puts a server VALIDATION_ERROR on its fields; true when every detail landed on one. */
export function applyServerErrors<T extends FieldValues>(e: unknown, setError: UseFormSetError<T>, fields: readonly Path<T>[]): boolean {
  if (!(e instanceof ApiError) || e.code !== 'VALIDATION_ERROR' || !Array.isArray(e.details)) return false;
  let all = e.details.length > 0;
  for (const d of e.details as { location?: string; path?: string; message?: string }[]) {
    const field = fields.find((f) => f === d.path);
    if (d.location === 'body' && field) setError(field, { type: 'server', message: d.message ?? 'This value is not valid' }, { shouldFocus: true });
    else all = false;
  }
  return all;
}

export const primaryButton = 'inline-flex h-12 items-center justify-center gap-2 rounded-md bg-brand-700 px-6 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800 disabled:bg-surface-100 disabled:text-ink-500 md:h-11';
export const secondaryButton = 'inline-flex h-12 items-center justify-center gap-2 rounded-md border-[1.5px] border-ink-900 px-5 text-sm font-semibold uppercase tracking-[0.06em] text-ink-900 hover:bg-ink-900 hover:text-white disabled:border-surface-200 disabled:bg-surface-100 disabled:text-ink-500 md:h-11';
export const dangerButton = 'inline-flex h-12 items-center justify-center gap-2 rounded-md bg-danger-700 px-6 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:opacity-90 disabled:bg-surface-100 disabled:text-ink-500 md:h-11';
export const textLink = 'font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800';

export function CheckboxField({ id, label, error, ...input }: { id: string; label: ReactNode; error?: string | undefined; ref?: React.Ref<HTMLInputElement> } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'>) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <input id={id} type="checkbox" {...input} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} className="mt-0.5 h-5 w-5 shrink-0 accent-brand-700" />
        <label htmlFor={id} className="text-sm text-ink-900">{label}</label>
      </div>
      {error && <p id={`${id}-error`} className="mt-1 text-sm text-danger-700">{error}</p>}
    </div>
  );
}

export function SelectField({ id, label, error, children, ...select }: { id: string; label: string; error?: string | undefined; children: ReactNode; ref?: React.Ref<HTMLSelectElement> } & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'>) {
  return (
    <div>
      <label htmlFor={id} className="block text-[13px] font-medium text-ink-900">{label}</label>
      <select id={id} {...select} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
        className="mt-1 block h-12 w-full rounded-md border border-border-input bg-white px-3 text-base text-ink-900 md:h-11">{children}</select>
      {error && <p id={`${id}-error`} className="mt-1 text-sm text-danger-700">{error}</p>}
    </div>
  );
}
