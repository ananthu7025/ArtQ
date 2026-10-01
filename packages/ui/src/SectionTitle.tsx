/** Signature section title: eyebrow, serif heading flanked by decorative teal lines, optional subtitle (design-system.md §5.1). */
export function SectionTitle({ title, eyebrow, subtitle, level = 2 }: { title: string; eyebrow?: string; subtitle?: string; level?: 2 | 3 }) {
  const H = level === 2 ? 'h2' : 'h3';
  const line = { flex: 1, height: 1.5, background: 'var(--brand-500)' } as const;
  return (
    <div style={{ textAlign: 'center' }}>
      {eyebrow && <p style={{ margin: 0, font: '600 13px var(--font-body)', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-900)' }}>{eyebrow}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span aria-hidden="true" style={line} />
        <H style={{ margin: 0, font: '600 22px var(--font-display)', color: 'var(--ink-900)' }}>{title}</H>
        <span aria-hidden="true" style={line} />
      </div>
      {subtitle && <p style={{ margin: '4px 0 0', color: 'var(--ink-900)', fontWeight: 500 }}>{subtitle}</p>}
    </div>
  );
}
