'use client';
// A password input with a show/hide toggle, same look and error rule as TextField (components/form/fields.tsx).
import { useState, type InputHTMLAttributes } from 'react';
import type { FieldProps } from './fields';

/** A password input with a show/hide button (the button never submits and keeps its own name). */
export function PasswordField({ id, label, error, hint, ...input }: Omit<FieldProps, 'tone' | 'hideLabel' | 'inputClassName'> & { hint?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'>) {
  const [shown, setShown] = useState(false);
  const described = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-[13px] font-medium text-ink-900">{label}</label>
      <div className="relative mt-1">
        <input id={id} type={shown ? 'text' : 'password'} {...input} aria-invalid={error ? true : undefined} aria-describedby={described}
          className="block h-12 w-full rounded-md border border-border-input bg-white pl-3 pr-20 text-base text-ink-900 md:h-11" />
        <button type="button" onClick={() => setShown((s) => !s)} aria-controls={id}
          className="absolute inset-y-1 right-1 rounded px-3 text-sm font-medium text-brand-700 hover:bg-surface-100">{shown ? 'Hide' : 'Show'}<span className="sr-only"> password</span></button>
      </div>
      {hint && <p id={`${id}-hint`} className="mt-1 text-sm text-ink-500">{hint}</p>}
      {error && <p id={`${id}-error`} className="mt-1 text-sm text-danger-700">{error}</p>}
    </div>
  );
}

