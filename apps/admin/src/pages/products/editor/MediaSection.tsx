// Media (product.md §7.4): upload (presign → PUT to storage → complete), reorder, cover, alt text, per-image state.
// Every change saves the whole ordered list (PUT /products/:id/images); processing images are polled until settled.
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Loader2, Trash2, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { IMAGE_TYPES, imageProblem, uploadImage } from '../../../api/upload';
import { useAuth } from '../../../auth/AuthProvider';
import { errorMessage } from '../../../components/feedback';
import { FormAlert } from '../../../components/form';
import type { ProductPayload } from './schema';

type Image = ProductPayload['images'][number];
type Item = { mediaId: number; alt: string | null; isCover: boolean };

function StateBadge({ status, reason }: { status: string; reason?: string | null | undefined }) {
  if (status === 'READY') return <span className="rounded-full bg-[#dcfce7] px-2 py-0.5 text-xs font-semibold text-success-700">Ready</span>;
  if (status === 'FAILED' || status === 'REJECTED') return <span className="inline-flex items-center gap-1 rounded-full bg-[#fee2e2] px-2 py-0.5 text-xs font-semibold text-danger-700" title={reason ?? undefined}><XCircle aria-hidden size={12} /> {status === 'REJECTED' ? 'Rejected' : 'Failed'}</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-surface-100 px-2 py-0.5 text-xs font-semibold text-ink-700"><Loader2 aria-hidden size={12} className="animate-spin motion-reduce:animate-none" /> Processing</span>;
}

export function MediaSection({ product, canEdit }: { product: ProductPayload; canEdit: boolean }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [alts, setAlts] = useState<Record<number, string>>({});
  const images = product.images;
  const items = (list: Image[]): Item[] => list.map((i) => ({ mediaId: i.mediaId, alt: alts[i.mediaId] ?? i.alt, isCover: i.isCover }));

  /** Saves the list; true when the server accepted it (the caller only confirms success then). */
  const save = async (next: Item[]): Promise<boolean> => {
    setError(null);
    try {
      await api.request('PUT', `/admin/products/${product.id}/images`, { body: { images: next.map((i) => ({ mediaId: i.mediaId, alt: i.alt?.trim() ? i.alt.trim() : null, isCover: i.isCover })) } });
      await qc.invalidateQueries({ queryKey: ['product', product.id] });
      return true;
    } catch (e) { setError(errorMessage(e)); return false; }
  };

  const upload = async (files: FileList) => {
    setError(null);
    const added: Item[] = [];
    for (const file of Array.from(files)) {
      const problem = imageProblem(file);
      if (problem) { setError(problem); continue; }
      setUploading((u) => [...u, file.name]);
      try {
        added.push({ mediaId: await uploadImage(api, file), alt: null, isCover: false });
      } catch (e) { setError(`${file.name}: ${errorMessage(e)}`); }
      finally { setUploading((u) => u.filter((n) => n !== file.name)); }
    }
    if (added.length) {
      const next = [...items(images), ...added];
      if (!next.some((i) => i.isCover)) next[0]!.isCover = true;
      // Uploaded is not attached: only say so once the product's list was saved (otherwise the error is shown).
      if (await save(next)) toast.success(added.length === 1 ? 'Image added' : `${added.length} images added`);
    }
    if (input.current) input.current.value = '';
  };

  const move = (from: number, to: number) => { const next = items(images); const [m] = next.splice(from, 1); next.splice(to, 0, m!); void save(next); };
  const cover = (mediaId: number) => void save(items(images).map((i) => ({ ...i, isCover: i.mediaId === mediaId })));
  const remove = (mediaId: number) => {
    const next = items(images).filter((i) => i.mediaId !== mediaId);
    if (next.length && !next.some((i) => i.isCover)) next[0]!.isCover = true;
    void save(next);
  };

  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex h-11 cursor-pointer items-center rounded-md bg-brand-700 px-4 font-medium text-white focus-within:outline-2 focus-within:outline-brand-700">
            Upload images
            <input ref={input} type="file" accept={IMAGE_TYPES.join(',')} multiple className="sr-only" onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); }} />
          </label>
          <span className="text-sm text-ink-700">JPEG, PNG, WebP or AVIF, up to 15 MB. The first ready cover is shown in listings.</span>
        </div>
      )}
      {uploading.length > 0 && <p className="flex items-center gap-2 text-sm text-ink-700" role="status"><Loader2 aria-hidden size={14} className="animate-spin motion-reduce:animate-none" /> Uploading {uploading.join(', ')}…</p>}
      {error && <FormAlert>{error}</FormAlert>}
      {images.length === 0 ? <p className="text-sm text-ink-700">No images yet. A ready cover image is needed to publish.</p> : (
        <ol className="space-y-2" aria-label="Product images">
          {images.map((img, i) => {
            const thumb = img.media.renditions?.['160'] ?? Object.values(img.media.renditions ?? {})[0];
            return (
              <li key={img.mediaId} className="flex flex-wrap items-center gap-3 rounded-md border border-surface-200 p-2">
                <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-surface-200 bg-surface-50">
                  {thumb ? <img src={thumb} alt="" className="h-16 w-16 object-cover" /> : <Loader2 aria-hidden size={18} className="text-ink-700" />}
                </span>
                <div className="min-w-48 flex-1 space-y-1">
                  <div className="flex items-center gap-2"><StateBadge status={img.media.status} reason={img.media.failureReason} />{img.isCover && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-800">Cover</span>}</div>
                  <label className="block text-xs text-ink-700" htmlFor={`alt-${img.mediaId}`}>Alt text (describe the image)</label>
                  <input id={`alt-${img.mediaId}`} disabled={!canEdit} maxLength={200} className="h-9 w-full rounded-md border border-border-input px-2 text-sm"
                    value={alts[img.mediaId] ?? img.alt ?? ''} onChange={(e) => setAlts((a) => ({ ...a, [img.mediaId]: e.target.value }))}
                    onBlur={() => { if ((alts[img.mediaId] ?? img.alt ?? '') !== (img.alt ?? '')) void save(items(images)); }} />
                </div>
                {canEdit && (
                  <div className="flex items-center gap-1">
                    <label className="mr-2 flex items-center gap-1 text-sm text-ink-900"><input type="radio" name="cover" className="h-4 w-4 accent-brand-700" checked={img.isCover} onChange={() => cover(img.mediaId)} aria-label={`Use image ${i + 1} as the cover`} /> Cover</label>
                    <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded hover:bg-surface-100 disabled:opacity-40" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Move image ${i + 1} up`}><ArrowUp aria-hidden size={16} /></button>
                    <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded hover:bg-surface-100 disabled:opacity-40" disabled={i === images.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move image ${i + 1} down`}><ArrowDown aria-hidden size={16} /></button>
                    <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded text-danger-700 hover:bg-surface-100" onClick={() => remove(img.mediaId)} aria-label={`Remove image ${i + 1}`}><Trash2 aria-hidden size={16} /></button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
