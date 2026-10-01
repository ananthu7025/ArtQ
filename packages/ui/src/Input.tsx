import { useId, type InputHTMLAttributes } from 'react';

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & { label: string; error?: string; hint?: string; id?: string };

/** Labelled input; errors and hints are linked with aria-describedby (design-system.md §5.3). 16 px text avoids iOS zoom. */
export function Input({ label, error, hint, id, style, ...rest }: InputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label htmlFor={inputId} style={{ font: '500 13px/1.4 var(--font-body)', color: 'var(--ink-900)' }}>{label}</label>
      <input
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        style={{ minHeight: 48, padding: '0 12px', font: '400 16px var(--font-body)', borderRadius: 'var(--radius-sm)',
                 border: `1px solid ${error ? 'var(--danger-700)' : 'var(--border-input)'}`, ...style }}
      />
      {error && <p id={errorId} role="alert" style={{ margin: 0, color: 'var(--danger-700)', fontSize: 12 }}>{error}</p>}
      {hint && <p id={hintId} style={{ margin: 0, color: 'var(--ink-500)', fontSize: 12 }}>{hint}</p>}
    </div>
  );
}
