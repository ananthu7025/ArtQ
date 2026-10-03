// Responsive image from an API MediaRef: WebP renditions in srcset, intrinsic size set (no layout shift), the blurred
// placeholder behind it while it loads. Plain <img>: the API already serves sized WebP renditions from the CDN.
import type { MediaRef } from '@artq/shared';
import type { CSSProperties } from 'react';

export function Img({ media, sizes, className, priority = false, alt }: { media: MediaRef; sizes: string; className?: string; priority?: boolean; alt?: string }) {
  const style: CSSProperties | undefined = media.placeholder ? { backgroundImage: `url(${media.placeholder})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined;
  return (
    <img src={media.url} srcSet={media.srcset.webp} sizes={sizes} width={media.width} height={media.height} alt={alt ?? media.alt}
      loading={priority ? 'eager' : 'lazy'} decoding={priority ? 'sync' : 'async'} fetchPriority={priority ? 'high' : 'auto'}
      className={className} style={style} />
  );
}

/** Neutral stand-in with the ArtQ mark when there is no image (design-system.md §5.5). Without a label it is decoration. */
export function ImgPlaceholder({ label, className = '' }: { label?: string; className?: string }) {
  return (
    <div {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })} className={`flex items-center justify-center bg-surface-100 ${className}`}>
      <span aria-hidden className="font-display text-lg font-semibold tracking-[0.25em] text-ink-700">ARTQ</span>
    </div>
  );
}
