'use client';
// Announcement bar (product.md §4.1): brand-800 strip, white text, messages scroll as a marquee separated by "•".
// Moving content needs a way to stop it (WCAG 2.2.2): it pauses on hover/focus and has a Pause button; under
// prefers-reduced-motion it does not move at all (globals.css).
import { Pause, Play } from 'lucide-react';
import { useState } from 'react';

export function AnnouncementBar({ enabled, messages }: { enabled: boolean; messages: string[] }) {
  const [paused, setPaused] = useState(false);
  const items = messages.map((m) => m.trim()).filter(Boolean);
  if (!enabled || items.length === 0) return null;
  const line = (hidden: boolean) => (
    <span className="flex shrink-0 items-center" aria-hidden={hidden || undefined}>
      {items.map((m, i) => <span key={i} className="flex items-center"><span className="px-6">{m}</span><span aria-hidden>•</span></span>)}
    </span>
  );
  return (
    <section aria-label="Announcements" className="relative bg-brand-800 text-[12px] text-white md:text-[13px]">
      <div className="marquee flex h-9 items-center overflow-hidden pr-11" data-paused={paused || undefined}>
        <div className="marquee-track flex w-max">{line(false)}{line(true)}</div>
      </div>
      <button type="button" onClick={() => setPaused((p) => !p)} aria-pressed={paused}
        className="absolute right-0 top-0 flex h-9 w-11 items-center justify-center bg-brand-800 text-white hover:bg-ink-900 focus-visible:outline-brand-300">
        {paused ? <Play aria-hidden size={14} /> : <Pause aria-hidden size={14} />}
        <span className="sr-only">{paused ? 'Play announcements' : 'Pause announcements'}</span>
      </button>
    </section>
  );
}
