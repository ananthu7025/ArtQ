'use client';
// Hero (product.md §5.1): the poster/image is rendered first (it is the page's largest element, so it loads with high
// priority); a slide's video is added only after load, and never on save-data or reduced-motion. Several slides rotate
// every `intervalMs` as a sliding track (swipe, arrows, dots), with a Pause button, pausing on hover/focus, and no motion
// under reduced motion. One slide is a still picture with no controls. Without slides the brand hero
// ("ARTQ / Wood moulds & resins") is shown.
import type { HomeHeroSlide } from '@artq/shared';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
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

const ctaClass = 'inline-flex h-10 items-center justify-center rounded-md bg-white px-5 text-xs font-semibold uppercase tracking-[0.06em] text-brand-800 hover:bg-brand-50';
const arrowClass = 'absolute top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-ink-900 shadow hover:bg-white md:flex';

export function Hero({ slides, intervalMs }: { slides: HomeHeroSlide[]; intervalMs: number }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const still = useStill();
  const many = slides.length > 1;
  const rotating = many && !paused && !hovered && !still;
  const track = useRef<HTMLDivElement>(null);
  const moving = useRef<ReturnType<typeof setTimeout> | null>(null);   // set while the page itself is scrolling the track
  useEffect(() => {
    if (!rotating) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % slides.length), intervalMs);
    return () => clearInterval(t);
  }, [rotating, slides.length, intervalMs]);

  // Slide the track to the current slide (dots, arrows and autoplay move it; a swipe already has). The scroll events this
  // causes are ignored until it lands, or they would report in-between positions and pull the slider back.
  useEffect(() => {
    const t = track.current;
    if (!t || !t.scrollTo) return;
    const left = index * t.clientWidth;
    if (Math.abs(t.scrollLeft - left) <= 2) return;
    if (moving.current) clearTimeout(moving.current);
    moving.current = setTimeout(() => { moving.current = null; }, still ? 50 : 700);
    t.scrollTo({ left, behavior: still ? 'auto' : 'smooth' });
  }, [index, still]);
  useEffect(() => () => { if (moving.current) clearTimeout(moving.current); }, []);
  // A resize changes the slide width: keep the current slide in place.
  useEffect(() => {
    const onResize = () => { const t = track.current; if (t?.scrollTo) t.scrollTo({ left: index * t.clientWidth, behavior: 'auto' }); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [index]);
  const onTrackScroll = (t: HTMLDivElement) => {
    if (moving.current) return;
    const i = Math.max(0, Math.min(slides.length - 1, Math.round(t.scrollLeft / Math.max(1, t.clientWidth))));
    if (i !== index) setIndex(i);
  };
  const go = (i: number) => setIndex((i + slides.length) % slides.length);

  if (slides.length === 0) {
    return (
      <section aria-label="Welcome" className="relative flex min-h-[60vh] items-center justify-center bg-[linear-gradient(135deg,#00627a,#006d68,#00756f)] px-4 text-center text-white md:min-h-[70vh]">
        <div>
          <h1 className="font-display text-[44px] font-semibold tracking-[0.08em] md:text-[88px]">ARTQ</h1>
          <p className="font-eyebrow mt-2 text-[15px] uppercase tracking-[0.3em] md:text-[17px]">Wood moulds &amp; resins</p>
          <Link href="/shop" className={`mt-8 ${ctaClass}`}>Shop now</Link>
        </div>
      </section>
    );
  }
  return (
    <section aria-roledescription="carousel" aria-label="Featured" className="relative overflow-hidden bg-ink-900 text-white"
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onFocus={() => setHovered(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHovered(false); }}>
      {/* One slide: a still picture. More than one: a track that slides, with swipe, arrows, dots and autoplay. */}
      <div ref={track} onScroll={(e) => onTrackScroll(e.currentTarget)} data-slider={many || undefined}
        className="flex snap-x snap-mandatory overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {slides.map((s, i) => {
          const active = i === index;
          return (
            <div key={s.id} role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${slides.length}`} aria-hidden={!active || undefined} inert={!active}
              className="relative min-h-[60vh] w-full shrink-0 snap-center md:min-h-[70vh]">
              {s.image && (
                <picture>
                  {s.mobileImage && <source media="(max-width: 767px)" srcSet={s.mobileImage.srcset.webp} sizes="100vw" />}
                  <Img media={s.image} alt="" sizes="100vw" priority={i === 0} className="absolute inset-0 h-full w-full object-cover" />
                </picture>
              )}
              <SlideVideo slide={s} playing={active && !paused} />
              <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgba(17,24,39,0.15),rgba(17,24,39,0.6))]" />
              <div className="relative flex min-h-[60vh] flex-col items-center justify-center px-4 text-center md:min-h-[70vh]">
                {/* Only the heading and subheading the admin wrote are shown: no default "ARTQ / Wood moulds & resins" on top of the
                    slide's own picture. The first slide keeps a hidden h1 so the page outline is unchanged. */}
                {s.heading
                  ? (i === 0 ? <h1 className="font-display text-[44px] font-semibold tracking-[0.08em] md:text-[88px]">{s.heading}</h1>
                    : <p className="font-display text-[44px] font-semibold tracking-[0.08em] md:text-[88px]">{s.heading}</p>)
                  : i === 0 && <h1 className="sr-only">ARTQ</h1>}
                {s.subheading && <p className="font-eyebrow mt-2 text-[15px] uppercase tracking-[0.3em] md:text-[17px]">{s.subheading}</p>}
                {s.ctaText && s.ctaLink && (
                  <Link href={s.ctaLink} className={`${ctaClass} ${s.heading || s.subheading ? 'mt-6' : ''}`}>{s.ctaText}</Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {many && (
        <>
          <button type="button" onClick={() => go(index - 1)} aria-label="Previous slide" className={`${arrowClass} left-3`}><ChevronLeft aria-hidden size={22} /></button>
          <button type="button" onClick={() => go(index + 1)} aria-label="Next slide" className={`${arrowClass} right-3`}><ChevronRight aria-hidden size={22} /></button>
          <div className="absolute inset-x-0 bottom-4 flex items-center justify-center gap-1">
            {slides.map((s, i) => (
              <button key={s.id} type="button" onClick={() => setIndex(i)} aria-label={`Show slide ${i + 1}`} aria-current={i === index || undefined}
                className="flex h-11 w-6 items-center justify-center"><span className={`block h-2.5 w-2.5 rounded-full border border-white ${i === index ? 'bg-white' : 'bg-transparent'}`} /></button>
            ))}
          </div>
        </>
      )}
      {(many || slides.some((s) => s.video)) && (
        <div className="absolute bottom-4 right-4">
          <button type="button" onClick={() => setPaused((p) => !p)} aria-pressed={paused}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-ink-900/70 text-white hover:bg-ink-900">
            {paused ? <Play aria-hidden size={18} /> : <Pause aria-hidden size={18} />}<span className="sr-only">{paused ? 'Play' : 'Pause'} the featured slides</span>
          </button>
        </div>
      )}
    </section>
  );
}
