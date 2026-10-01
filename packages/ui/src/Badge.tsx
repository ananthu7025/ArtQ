import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'new' | 'discount' | 'success' | 'warning' | 'danger';
const tones: Record<BadgeTone, { bg: string; fg: string }> = {
  neutral: { bg: 'var(--surface-200)', fg: 'var(--ink-700)' },
  new: { bg: 'var(--ink-900)', fg: '#fff' },
  discount: { bg: 'var(--brand-700)', fg: '#fff' },
  success: { bg: 'var(--success-700)', fg: '#fff' },
  warning: { bg: 'var(--warning-bg)', fg: 'var(--warning-ink)' },
  danger: { bg: 'var(--danger-700)', fg: '#fff' },
};

/** Status is conveyed by text, never colour alone. */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  const t = tones[tone];
  return <span style={{ background: t.bg, color: t.fg, font: '600 11px/1 var(--font-body)', textTransform: 'uppercase', padding: '4px 8px', borderRadius: 'var(--radius-sm)', display: 'inline-block' }}>{children}</span>;
}
