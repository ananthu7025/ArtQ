'use client';
// "Stories with our product" (product.md §5.1, design-system.md §5.6): a carousel with labelled Previous/Next buttons;
// it advances every 6 s, pauses on hover/focus or with the Pause button, and never moves under reduced motion.
import type { HomeTestimonial } from '@artq/shared';
import { ChevronLeft, ChevronRight, Pause, Play, Star } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useStill } from '../motion';
import { SectionHeading } from '../SectionHeading';

export function Testimonials({ items, intervalMs = 6000 }: { items: HomeTestimonial[]; intervalMs?: number }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(false);
  const still = useStill();
  const track = useRef<HTMLDivElement>(null);
  const go = (i: number) => {
    const n = (i + items.length) % items.length;
    setIndex(n);
    const el = track.current?.children[n] as HTMLElement | undefined;
    if (el && track.current) track.current.scrollTo({ left: el.offsetLeft - track.current.offsetLeft, behavior: still ? 'auto' : 'smooth' });
  };
  useEffect(() => {
    if (paused || held || still || items.length < 2) return;
    const t = setInterval(() => go(index + 1), intervalMs);
    return () => clearInterval(t);
  });   // re-armed every render so it always advances from the current slide

  return (
    <section aria-labelledby="stories-heading" aria-roledescription="carousel" className="mx-auto max-w-[1320px] px-4 py-10 md:px-6 md:py-[72px] lg:px-8"
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHeld(false); }}>
      <SectionHeading id="stories-heading" title="Stories with our product" />
      <div ref={track} className="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-2 motion-reduce:scroll-auto">
        {items.map((t, i) => (
          <div key={t.id} role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${items.length}`} className="relative w-[86%] shrink-0 snap-start rounded-lg border border-surface-200 bg-white p-6 md:w-[calc(50%-8px)] lg:w-[calc(33.333%-11px)]">
            <p className="flex gap-0.5" aria-hidden>{Array.from({ length: 5 }, (_, s) => <Star key={s} size={16} className={s < t.rating ? 'fill-star text-star' : 'text-surface-200'} />)}</p>
            <p className="sr-only">Rated {t.rating} out of 5</p>
            <blockquote className="mt-3 text-[15px] italic leading-relaxed text-ink-700">“{t.quote}”</blockquote>
            <p className="mt-4 text-sm font-semibold text-ink-900">{t.name}{t.location && <span className="font-normal text-ink-700">, {t.location}</span>}</p>
            {t.product && <Link href={`/product/${t.product.slug}`} className="mt-1 inline-block text-sm text-brand-700 underline">{t.product.name}</Link>}
          </div>
        ))}
      </div>
      {items.length > 1 && (
        <div className="mt-4 flex items-center justify-center gap-2">
          <button type="button" onClick={() => go(index - 1)} className="flex h-11 w-11 items-center justify-center rounded-full border border-border-input text-ink-900 hover:bg-surface-100"><ChevronLeft aria-hidden size={20} /><span className="sr-only">Previous story</span></button>
          <button type="button" onClick={() => setPaused((p) => !p)} aria-pressed={paused} className="flex h-11 w-11 items-center justify-center rounded-full border border-border-input text-ink-900 hover:bg-surface-100">
            {paused ? <Play aria-hidden size={18} /> : <Pause aria-hidden size={18} />}<span className="sr-only">{paused ? 'Play' : 'Pause'} stories</span>
          </button>
          <button type="button" onClick={() => go(index + 1)} className="flex h-11 w-11 items-center justify-center rounded-full border border-border-input text-ink-900 hover:bg-surface-100"><ChevronRight aria-hidden size={20} /><span className="sr-only">Next story</span></button>
        </div>
      )}
    </section>
  );
}
