'use client';
// "Trending now" reels (product.md §5.1, design-system.md §5.6): 9:16 videos linked to products. A reel plays (muted,
// looping) while at least half of it is on screen, one at a time, and only for viewers who have not asked for reduced
// motion or saved data; every reel has its own Play/Pause button.
import type { HomeReel } from '@artq/shared';
import { Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useStill } from '../motion';
import { SectionHeading } from '../SectionHeading';

export function Reels({ reels }: { reels: HomeReel[] }) {
  const [playing, setPlaying] = useState<number | null>(null);
  const [stopped, setStopped] = useState<Set<number>>(new Set());   // reels the viewer paused stay paused
  const videos = useRef(new Map<number, HTMLVideoElement>());
  const visible = useRef(new Map<number, number>());
  const still = useStill();

  useEffect(() => {
    if (still || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) visible.current.set(Number((e.target as HTMLElement).dataset.reel), e.intersectionRatio);
      // The most visible reel (≥ 50 %) that the viewer has not paused.
      const best = [...visible.current.entries()].filter(([id, r]) => r >= 0.5 && !stopped.has(id)).sort((a, b) => b[1] - a[1])[0];
      setPlaying(best ? best[0] : null);
    }, { threshold: [0, 0.5, 0.75, 1] });
    for (const v of videos.current.values()) io.observe(v);
    return () => io.disconnect();
  }, [stopped, still]);

  useEffect(() => {
    for (const [id, v] of videos.current) { if (id === playing) void v.play().catch(() => {}); else v.pause(); }
  }, [playing]);

  const toggle = (id: number) => {
    if (playing === id) { setStopped((s) => new Set(s).add(id)); setPlaying(null); }
    else { setStopped((s) => { const n = new Set(s); n.delete(id); return n; }); setPlaying(id); }
  };

  return (
    <section aria-labelledby="trending-heading" className="mx-auto max-w-[1320px] px-4 py-10 md:px-6 md:py-[72px] lg:px-8">
      <SectionHeading id="trending-heading" title="Trending now" />
      <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:grid md:grid-cols-4 md:gap-5 md:overflow-visible md:px-0">
        {reels.map((r) => {
          const label = r.title ?? (r.product ? `Reel: ${r.product.name}` : 'ArtQ reel');
          return (
            <li key={r.id} className="w-[46vw] shrink-0 snap-start md:w-auto">
              <div className="relative aspect-[9/16] overflow-hidden rounded-xl bg-ink-900">
                <video ref={(el) => { if (el) videos.current.set(r.id, el); else videos.current.delete(r.id); }} data-reel={r.id}
                  src={r.video.url} poster={r.poster?.url} muted loop playsInline preload="none" aria-label={label} className="h-full w-full object-cover" />
                {!r.poster && <span aria-hidden className="absolute inset-0 flex items-center justify-center font-display text-lg tracking-[0.25em] text-white/70">ARTQ</span>}
                <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-[linear-gradient(180deg,rgba(17,24,39,0),rgba(17,24,39,0.85))]" />
                <button type="button" onClick={() => toggle(r.id)} aria-pressed={playing === r.id}
                  className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full bg-ink-900/70 text-white hover:bg-ink-900">
                  {playing === r.id ? <Pause aria-hidden size={18} /> : <Play aria-hidden size={18} />}<span className="sr-only">{playing === r.id ? 'Pause' : 'Play'} {label}</span>
                </button>
                {r.product && (
                  <Link href={`/product/${r.product.slug}`} className="absolute inset-x-0 bottom-0 line-clamp-2 p-3 text-sm font-semibold text-white hover:underline">{r.product.name}</Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
