'use client';
// Product gallery (product.md §5.3): swipeable main image (scroll snap), thumbnails, Previous/Next, a full-screen
// viewer with zoom (Esc closes, arrows move), and the product video as the last item (controls, never autoplays).
// `focus` brings a picture to the front, e.g. the photo of the colour just chosen.
import type { MediaRef, VideoRef } from '@artq/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Play, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Img, ImgPlaceholder } from '../Img';

type Item = { kind: 'image'; media: MediaRef } | { kind: 'video'; media: VideoRef; poster: MediaRef | null };

export function Gallery({ name, images, video, focus }: { name: string; images: MediaRef[]; video: VideoRef | null; focus?: MediaRef | null }) {
  const items: Item[] = [...images.map((media) => ({ kind: 'image' as const, media })), ...(video ? [{ kind: 'video' as const, media: video, poster: images[0] ?? null }] : [])];
  const [index, setIndex] = useState(0);
  const [viewer, setViewer] = useState(false);
  const [zoom, setZoom] = useState(false);
  const track = useRef<HTMLDivElement>(null);

  const show = (i: number) => setIndex(Math.max(0, Math.min(items.length - 1, i)));
  // A newly chosen variant brings its photo to the front (adjusting state during render, not in an effect).
  const [focused, setFocused] = useState(focus?.id);
  if (focus?.id !== focused) {
    setFocused(focus?.id);
    const i = focus ? items.findIndex((it) => it.kind === 'image' && it.media.id === focus.id) : -1;
    if (i >= 0) setIndex(i);
  }
  // Keep the swipe track on the current photo (a swipe already is; buttons, thumbnails and variants move it).
  useEffect(() => {
    const t = track.current;
    const el = t?.children[index] as HTMLElement | undefined;
    if (t && el && Math.abs(t.scrollLeft - el.offsetLeft) > 2) t.scrollTo?.({ left: el.offsetLeft, behavior: 'smooth' });
  }, [index]);

  if (items.length === 0) return <ImgPlaceholder label={`${name}: no photo yet`} className="aspect-square w-full rounded-lg" />;
  const current = items[index]!;

  return (
    <section aria-label={`${name} photos`} className="min-w-0">
      <div className="relative">
        <div ref={track} onScroll={(e) => { const t = e.currentTarget; const i = Math.round(t.scrollLeft / Math.max(1, t.clientWidth)); if (i !== index) setIndex(i); }}
          className="flex aspect-square snap-x snap-mandatory overflow-x-auto overflow-y-hidden rounded-lg bg-surface-100 [scrollbar-width:none]">
          {items.map((it, i) => (
            <div key={`${it.kind}-${it.media.id}`} className="relative h-full w-full shrink-0 snap-start" aria-hidden={i !== index || undefined}>
              {it.kind === 'image'
                ? (
                  <button type="button" onClick={() => { setIndex(i); setViewer(true); }} tabIndex={i === index ? 0 : -1} className="block h-full w-full cursor-zoom-in" aria-label={`Open photo ${i + 1} of ${items.length} full screen`}>
                    <Img media={it.media} sizes="(min-width: 1024px) 55vw, 100vw" priority={i === 0} className="h-full w-full object-cover" />
                  </button>
                )
                : <video src={it.media.url} poster={it.poster?.url} controls playsInline preload="none" className="h-full w-full bg-ink-900 object-contain" aria-label={`${name} video`} tabIndex={i === index ? 0 : -1} />}
            </div>
          ))}
        </div>
        {items.length > 1 && (
          <>
            <button type="button" onClick={() => show(index - 1)} disabled={index === 0} className="absolute left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink-900 shadow disabled:hidden" aria-label="Previous photo"><ChevronLeft aria-hidden size={20} /></button>
            <button type="button" onClick={() => show(index + 1)} disabled={index === items.length - 1} className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink-900 shadow disabled:hidden" aria-label="Next photo"><ChevronRight aria-hidden size={20} /></button>
            <p className="sr-only" aria-live="polite">Photo {index + 1} of {items.length}</p>
          </>
        )}
      </div>
      {items.length > 1 && (
        <ul className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Choose a photo">
          {items.map((it, i) => (
            <li key={`t-${it.kind}-${it.media.id}`} className="shrink-0">
              <button type="button" onClick={() => show(i)} aria-current={i === index || undefined} aria-label={it.kind === 'video' ? 'Show the video' : `Show photo ${i + 1}`}
                className={`relative block h-16 w-16 overflow-hidden rounded-md border-2 ${i === index ? 'border-brand-700' : 'border-transparent'}`}>
                {it.kind === 'image' ? <Img media={it.media} alt="" sizes="64px" className="h-full w-full object-cover" />
                  : <span className="flex h-full w-full items-center justify-center bg-ink-900 text-white"><Play aria-hidden size={20} /></span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Dialog.Root open={viewer} onOpenChange={(o) => { setViewer(o); if (!o) setZoom(false); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-ink-900/95" />
          <Dialog.Content aria-describedby={undefined} className="fixed inset-0 z-[61] flex flex-col focus:outline-none"
            onKeyDown={(e) => { if (e.key === 'ArrowRight') show(index + 1); if (e.key === 'ArrowLeft') show(index - 1); }}>
            <div className="flex items-center justify-between p-3 text-white">
              <Dialog.Title className="text-sm">{name} · {index + 1} of {items.length}</Dialog.Title>
              <div className="flex gap-1">
                {current.kind === 'image' && (
                  <button type="button" onClick={() => setZoom((z) => !z)} aria-pressed={zoom} className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-white/10" aria-label={zoom ? 'Zoom out' : 'Zoom in'}>
                    {zoom ? <ZoomOut aria-hidden size={22} /> : <ZoomIn aria-hidden size={22} />}
                  </button>
                )}
                <Dialog.Close className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-white/10" aria-label="Close"><X aria-hidden size={22} /></Dialog.Close>
              </div>
            </div>
            <div className={`relative flex-1 ${zoom ? 'overflow-auto' : 'flex items-center justify-center overflow-hidden'}`}>
              {current.kind === 'image'
                ? <Img media={current.media} sizes="100vw" className={zoom ? 'h-auto w-[200%] max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain'} />
                : <video src={current.media.url} controls playsInline className="max-h-full max-w-full" aria-label={`${name} video`} />}
              {items.length > 1 && !zoom && (
                <>
                  <button type="button" onClick={() => show(index - 1)} disabled={index === 0} className="absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink-900 disabled:hidden" aria-label="Previous photo"><ChevronLeft aria-hidden size={22} /></button>
                  <button type="button" onClick={() => show(index + 1)} disabled={index === items.length - 1} className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink-900 disabled:hidden" aria-label="Next photo"><ChevronRight aria-hidden size={22} /></button>
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
