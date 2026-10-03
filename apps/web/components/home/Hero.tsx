'use client';
// Hero (product.md §5.1): the poster/image is rendered first (it is the page's largest element, so it loads with high
// priority); a slide's video is added only after load, and never on save-data or reduced-motion. Several slides rotate
// every `intervalMs`, with a Pause button, pausing on hover/focus, and no rotation under reduced motion. Without slides
// the brand hero ("ARTQ / Wood moulds & resins") is shown.
import type { HomeHeroSlide } from '@artq/shared';
import { Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Img } from '../Img';
import { useStill } from '../motion';

function SlideVideo({ slide, playing }: { slide: HomeHeroSlide; playing: boolean }) {
  const allowed = !useStill();   // the server renders the poster only; the video is added in the browser
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { const v = ref.current; if (!v) return; if (playing) void v.play().catch(() => {}); else v.pause(); }, [playing, allowed]);
  if (!allowed || !slide.video) return null;
  return <video ref={ref} className="absolute inset-0 h-full w-full object-cover" src={slide.video.url} muted loop playsInline autoPlay={playing} preload="metadata" aria-hidden tabIndex={-1} />;
}

export function Hero({ slides, intervalMs }: { slides: HomeHeroSlide[]; intervalMs: number }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const still = useStill();
  const rotating = slides.length > 1 && !paused && !hovered && !still;
  useEffect(() => {
    if (!rotating) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % slides.length), intervalMs);
    return () => clearInterval(t);
  }, [rotating, slides.length, intervalMs]);

  if (slides.length === 0) {
    return (
      <section aria-label="Welcome" className="relative flex min-h-[60vh] items-center justify-center bg-[linear-gradient(135deg,#00627a,#006d68,#00756f)] px-4 text-center text-white md:min-h-[70vh]">
        <div>
          <h1 className="font-display text-[44px] font-semibold tracking-[0.08em] md:text-[88px]">ARTQ</h1>
          <p className="font-eyebrow mt-2 text-[15px] uppercase tracking-[0.3em] md:text-[17px]">Wood moulds &amp; resins</p>
          <Link href="/shop" className="mt-8 inline-flex h-12 items-center rounded-md bg-white px-6 text-sm font-semibold uppercase tracking-[0.06em] text-brand-800 hover:bg-brand-50">Shop now</Link>
        </div>
      </section>
    );
  }
  return (
    <section aria-roledescription="carousel" aria-label="Featured" className="relative min-h-[60vh] overflow-hidden bg-ink-900 text-white md:min-h-[70vh]"
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onFocus={() => setHovered(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHovered(false); }}>
      {slides.map((s, i) => {
        const active = i === index;
        return (
          <div key={s.id} role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${slides.length}`} hidden={!active} className="absolute inset-0">
            {s.image && (
              <picture>
                {s.mobileImage && <source media="(max-width: 767px)" srcSet={s.mobileImage.srcset.webp} sizes="100vw" />}
                <Img media={s.image} alt="" sizes="100vw" priority={i === 0} className="absolute inset-0 h-full w-full object-cover" />
              </picture>
            )}
            <SlideVideo slide={s} playing={active && !paused} />
            <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgba(17,24,39,0.15),rgba(17,24,39,0.6))]" />
            <div className="relative flex min-h-[60vh] flex-col items-center justify-center px-4 text-center md:min-h-[70vh]">
              {i === 0 ? <h1 className="font-display text-[44px] font-semibold tracking-[0.08em] md:text-[88px]">{s.heading ?? 'ARTQ'}</h1>
                : <p className="font-display text-[44px] font-semibold tracking-[0.08em] md:text-[88px]">{s.heading ?? 'ARTQ'}</p>}
              <p className="font-eyebrow mt-2 text-[15px] uppercase tracking-[0.3em] md:text-[17px]">{s.subheading ?? 'Wood moulds & resins'}</p>
              {s.ctaText && s.ctaLink && (
                <Link href={s.ctaLink} className="mt-8 inline-flex h-12 items-center rounded-md bg-white px-6 text-sm font-semibold uppercase tracking-[0.06em] text-brand-800 hover:bg-brand-50">{s.ctaText}</Link>
              )}
            </div>
          </div>
        );
      })}
      <div className="invisible min-h-[60vh] md:min-h-[70vh]" />
      {(slides.length > 1 || slides.some((s) => s.video)) && (
        <div className="absolute bottom-4 right-4 flex items-center gap-2">
          {slides.length > 1 && slides.map((s, i) => (
            <button key={s.id} type="button" onClick={() => setIndex(i)} aria-label={`Show slide ${i + 1}`} aria-current={i === index || undefined}
              className="flex h-11 w-6 items-center justify-center"><span className={`block h-2.5 w-2.5 rounded-full border border-white ${i === index ? 'bg-white' : 'bg-transparent'}`} /></button>
          ))}
          <button type="button" onClick={() => setPaused((p) => !p)} aria-pressed={paused}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-ink-900/70 text-white hover:bg-ink-900">
            {paused ? <Play aria-hidden size={18} /> : <Pause aria-hidden size={18} />}<span className="sr-only">{paused ? 'Play' : 'Pause'} the featured slides</span>
          </button>
        </div>
      )}
    </section>
  );
}
