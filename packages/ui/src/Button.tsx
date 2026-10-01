import type { ButtonHTMLAttributes, CSSProperties } from 'react';

type Variant = 'primary' | 'secondary';

const styles: Record<Variant, CSSProperties> = {
  primary: { background: 'var(--brand-700)', color: '#fff', border: 'none' },
  secondary: { background: 'transparent', color: 'var(--ink-900)', border: '1.5px solid var(--ink-900)' },
};

export function Button({ variant = 'primary', style, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...rest}
      style={{ ...styles[variant], borderRadius: 'var(--radius-md)', minHeight: 44, padding: '0 20px',
               font: '600 14px/1 var(--font-body)', letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer', ...style }}
    />
  );
}
