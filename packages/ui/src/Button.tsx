'use client';

import type { ButtonHTMLAttributes, CSSProperties, MouseEvent, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variants: Record<ButtonVariant, CSSProperties> = {
  primary: { background: 'var(--brand-700)', color: '#fff', border: '1.5px solid var(--brand-700)' },
  secondary: { background: 'transparent', color: 'var(--ink-900)', border: '1.5px solid var(--ink-900)' },
  ghost: { background: 'transparent', color: 'var(--brand-700)', border: '1.5px solid transparent' },
  danger: { background: 'var(--danger-700)', color: '#fff', border: '1.5px solid var(--danger-700)' },
};
const inactive: CSSProperties = { background: 'var(--surface-100)', color: 'var(--ink-500)', borderColor: 'var(--surface-200)', cursor: 'not-allowed' };

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean };

/**
 * Disabled/loading buttons use aria-disabled (not the disabled attribute) so they stay focusable and announced,
 * and clicks are swallowed (design-system.md §5.2).
 */
export function Button({ variant = 'primary', loading = false, disabled = false, style, onClick, children, type = 'button', ...rest }: ButtonProps) {
  const off = disabled || loading;
  const handle = (e: MouseEvent<HTMLButtonElement>) => { if (off) { e.preventDefault(); return; } onClick?.(e); };
  return (
    <button
      {...rest}
      type={type}
      aria-disabled={off || undefined}
      aria-busy={loading || undefined}
      onClick={handle}
      style={{ ...variants[variant], ...(off ? inactive : {}), borderRadius: 'var(--radius-md)', minHeight: 44, minWidth: 44, padding: '0 20px',
               font: '600 14px/1 var(--font-body)', letterSpacing: '0.06em', textTransform: 'uppercase', cursor: off ? 'not-allowed' : 'pointer', ...style }}
    >
      {loading ? <span role="status" aria-label="Loading">…</span> : children}
    </button>
  );
}

export type IconButtonProps = Omit<ButtonProps, 'children' | 'variant'> & { label: string; icon: ReactNode };

/** Icon-only button: the accessible name is mandatory. */
export function IconButton({ label, icon, style, ...rest }: IconButtonProps) {
  if (!label.trim()) throw new Error('IconButton requires a non-empty label');
  return (
    <Button {...rest} variant="ghost" aria-label={label} title={label} style={{ padding: 0, width: 44, borderRadius: 999, ...style }}>
      <span aria-hidden="true">{icon}</span>
    </Button>
  );
}
