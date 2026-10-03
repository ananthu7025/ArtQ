// Section title (design-system.md §5.1): optional eyebrow, serif heading between decorative teal lines, optional subtitle.
export function SectionHeading({ id, title, eyebrow, subtitle }: { id: string; title: string; eyebrow?: string; subtitle?: string }) {
  return (
    <div className="mb-6 text-center md:mb-8">
      {eyebrow && <p className="text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-900 md:text-sm">{eyebrow}</p>}
      <div className="mt-1 flex items-center gap-4">
        <span aria-hidden className="h-[1.5px] flex-1 bg-brand-500" />
        <h2 id={id} className="font-display text-[22px] font-semibold text-ink-900 md:text-[30px]">{title}</h2>
        <span aria-hidden className="h-[1.5px] flex-1 bg-brand-500" />
      </div>
      {subtitle && <p className="mt-1 text-sm text-ink-700 md:text-[15px]">{subtitle}</p>}
    </div>
  );
}
