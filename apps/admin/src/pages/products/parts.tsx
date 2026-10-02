// Building blocks of the Products page (product.md §7.3).
import { describeReadiness, formatINR, type ImageState, type ProductListRow } from '@artq/shared';
import * as Popover from '@radix-ui/react-popover';
import { AlertTriangle, Check, ImageOff, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../api/client';

const pill = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold';

/** 48 px cover thumbnail; processing, failed and missing look different, and every state keeps the same box (rows never jump). */
export function Thumb({ image, name }: { image: { state: ImageState; url: string | null }; name: string }) {
  const box = 'flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border';
  if (image.state === 'READY' && image.url) return <img src={image.url} alt="" width={48} height={48} className={`${box} border-surface-200 object-cover`} data-image-state="READY" />;
  if (image.state === 'PROCESSING') {
    return <span className={`${box} border-surface-200 bg-surface-100 text-ink-700`} data-image-state="PROCESSING" title="Image processing"><Loader2 aria-hidden size={18} className="animate-spin motion-reduce:animate-none" /><span className="sr-only">Image of {name} is processing</span></span>;
  }
  if (image.state === 'FAILED') {
    return <span className={`${box} border-danger-700 bg-[#fee2e2] text-danger-700`} data-image-state="FAILED" title="Image failed: retry processing in Media"><XCircle aria-hidden size={18} /><span className="sr-only">Image of {name} failed to process</span></span>;
  }
  return <span className={`${box} border-dashed border-border-input bg-surface-50 text-ink-700`} data-image-state="MISSING" title="No image: add one in the editor"><ImageOff aria-hidden size={18} /><span className="sr-only">{name} has no image</span></span>;
}

export function TypeBadge({ type }: { type: ProductListRow['type'] }) {
  // A product without a type is a genuinely unassigned draft: a neutral badge, never "Unknown" (product.md §7.3).
  return type ? <span className="text-ink-900">{type.name}</span> : <span className={`${pill} bg-surface-100 text-ink-700`}>Unassigned</span>;
}

export function PriceRange({ range }: { range: ProductListRow['priceRange'] }) {
  if (!range) return <span className="text-ink-700">No price</span>;
  return <span className="tabular-nums">{range.min === range.max ? formatINR(range.min) : `${formatINR(range.min)}–${formatINR(range.max)}`}</span>;
}

export function Stock({ row }: { row: ProductListRow }) {
  return (
    <span className="inline-flex items-center gap-2 tabular-nums">
      <span className={row.available === 0 ? 'font-semibold text-danger-700' : row.lowStock ? 'font-semibold text-warning-700' : 'text-ink-900'}>{row.available}</span>
      {row.available > 0 && row.lowStock && <span className="sr-only">(low stock)</span>}
      {row.oversold && <span className={`${pill} bg-[#fee2e2] text-danger-700`}>Oversold</span>}
    </span>
  );
}

export function StatusPill({ status }: { status: ProductListRow['status'] }) {
  if (status === 'ACTIVE') return <span className={`${pill} bg-[#dcfce7] text-success-700`}>Active</span>;
  if (status === 'ARCHIVED') return <span className={`${pill} bg-surface-200 text-ink-700`}>Archived</span>;
  return <span className={`${pill} bg-warning-bg text-warning-ink`}>Draft</span>;
}

function Failures({ codes, productId }: { codes: readonly string[]; productId: number }) {
  return (
    <>
      <ul className="mt-2 space-y-2 text-sm">
        {describeReadiness(codes).map((f) => (
          <li key={f.code}><span className="font-semibold text-ink-900">{f.check}:</span> <span className="text-ink-700">{f.fix}</span></li>
        ))}
      </ul>
      <Link to={`/products/${productId}`} className="mt-3 inline-block text-sm font-medium text-brand-700 underline">Fix in the editor</Link>
    </>
  );
}

const popoverPanel = 'z-50 w-80 rounded-lg border border-surface-200 bg-white p-4 shadow-lg outline-none';

/** ✓ when every publication check passes, ⚠ with the failing checks (click or keyboard) otherwise. */
export function ReadinessBadge({ row }: { row: ProductListRow }) {
  if (row.readinessFailures.length === 0) return <span className="inline-flex items-center text-success-700" title="Ready to publish"><Check aria-hidden size={18} /><span className="sr-only">Ready to publish</span></span>;
  return (
    <Popover.Root>
      <Popover.Trigger className="inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-warning-700 hover:bg-surface-100" aria-label={`${row.readinessFailures.length} publication checks failing for ${row.name}`}>
        <AlertTriangle aria-hidden size={18} /><span className="text-xs font-semibold">{row.readinessFailures.length}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={popoverPanel} sideOffset={6} align="start">
          <p className="font-semibold text-ink-900">Not ready to publish</p>
          <Failures codes={row.readinessFailures} productId={row.id} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Activation toggle = publish / unpublish (catalog:publish). Turning it on runs the gate; on refusal the switch stays
 * off and a popover lists what is missing. Without the permission it is shown read-only.
 */
export function PublishToggle({ row, canPublish, onToggle }: { row: ProductListRow; canPublish: boolean; onToggle: (on: boolean) => Promise<void> }) {
  const on = row.status === 'ACTIVE';
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string[] | null>(null);
  const label = `${on ? 'Unpublish' : 'Publish'} ${row.name}`;
  const toggle = async () => {
    setBusy(true);
    try { await onToggle(!on); setRefused(null); }
    catch (e) {
      const failures = e instanceof ApiError ? (e.details as { failures?: { code: string }[] } | undefined)?.failures : undefined;
      if (e instanceof ApiError && e.code === 'NOT_PUBLISHABLE' && failures) setRefused(failures.map((f) => f.code));
      else throw e;
    } finally { setBusy(false); }
  };
  const track = `relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 transition-colors ${on ? 'border-brand-700 bg-brand-700' : 'border-border-input bg-surface-200'} disabled:cursor-not-allowed`;
  const knob = <span aria-hidden className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />;
  if (!canPublish) {
    return <button type="button" role="switch" aria-checked={on} aria-label={`${row.name} is ${on ? 'published' : 'not published'} (read-only)`} disabled className={`${track} opacity-70`} title="You cannot publish products">{knob}</button>;
  }
  return (
    <Popover.Root open={refused !== null} onOpenChange={(o) => { if (!o) setRefused(null); }}>
      <Popover.Anchor asChild>
        <button type="button" role="switch" aria-checked={on} aria-label={label} aria-busy={busy || undefined} disabled={busy} onClick={() => void toggle()} className={track}>{knob}</button>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content className={popoverPanel} sideOffset={6} align="start" role="alertdialog" aria-label={`${row.name} cannot be published yet`}>
          <p className="font-semibold text-ink-900">Can&apos;t publish yet</p>
          {refused && <Failures codes={refused} productId={row.id} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
