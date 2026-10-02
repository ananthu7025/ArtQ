// Form fields (CLAUDE.md "Validation rule"): every form validates with the shared Zod schema from @artq/shared, and every
// invalid field looks the same: red border (any input/select/textarea with aria-invalid="true", styled in styles.css) and
// the message in red directly under it, linked with aria-describedby. Server VALIDATION_ERROR details land on their field.
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from '../api/client';

export const fieldClass = 'mt-1 block h-11 w-full rounded-md border border-border-input bg-white px-3 text-ink-900';

type Common = { id: string; label: string; error?: string | undefined; hint?: ReactNode };

function describedBy(id: string, error?: string, hint?: ReactNode) {
  return [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
}

function Messages({ id, error, hint }: Omit<Common, 'label'>) {
  return (
    <>
      {error && <p id={`${id}-error`} className="mt-1 text-sm text-danger-700">{error}</p>}
      {hint && <p id={`${id}-hint`} className="mt-1 text-sm text-ink-700">{hint}</p>}
    </>
  );
}

export function TextField({ id, label, error, hint, className, ...input }: Common & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-ink-900">{label}</label>
      <input id={id} {...input} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, error, hint)} className={fieldClass} />
      <Messages id={id} error={error} hint={hint} />
    </div>
  );
}

export function SelectField({ id, label, error, hint, className, children, ...select }: Common & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & { ref?: React.Ref<HTMLSelectElement> }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-ink-900">{label}</label>
      <select id={id} {...select} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, error, hint)} className={fieldClass}>{children}</select>
      <Messages id={id} error={error} hint={hint} />
    </div>
  );
}

/** Form-level message for errors that belong to no field. */
export function FormAlert({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-md bg-[#fee2e2] px-3 py-2 text-sm text-danger-700">{children}</p>;
}

/**
 * Puts a server VALIDATION_ERROR (`details: [{location, path, message}]`) on the matching form fields.
 * Returns true when every detail landed on a field (nothing left for a form-level alert).
 */
export function applyServerErrors<T extends FieldValues>(e: unknown, setError: UseFormSetError<T>, fields: readonly Path<T>[]): boolean {
  if (!(e instanceof ApiError) || e.code !== 'VALIDATION_ERROR' || !Array.isArray(e.details)) return false;
  const details = e.details as { location?: string; path?: string; message?: string }[];
  let all = details.length > 0;
  for (const d of details) {
    const field = fields.find((f) => f === d.path);
    if (d.location === 'body' && field) setError(field, { type: 'server', message: d.message ?? 'This value is not valid' }, { shouldFocus: true });
    else all = false;
  }
  return all;
}
