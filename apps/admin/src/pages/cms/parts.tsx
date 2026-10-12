// Shared pieces of the CMS & Messages page (task 6.1): a media picker (upload an image or video, see its processing
// state, remove it), an ordered list with Move up / Move down, Edit, Delete and an on/off state, and small helpers.
import type { CmsMedia } from '@artq/shared';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useAuth } from '../../auth/AuthProvider';
import { imageProblem, uploadImage, uploadVideo } from '../../api/upload';
import { btn, ConfirmDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';

export const primary = `${btn} bg-brand-700 text-white disabled:opacity-80`;
export const outline = `${btn} border border-border-input bg-white`;
export const quiet = `${btn} text-ink-900 hover:bg-surface-100`;
export const small = `${btn} h-9 px-3 text-sm`;
export const card = 'rounded-lg border border-surface-200 bg-white p-5';

/** An uploaded image or video id, shown as a thumbnail (or its state while it is processed). */
export function MediaField({ id, label, kind = 'IMAGE', value, preview, onChange, error, optional }: {
  id: string; label: string; kind?: 'IMAGE' | 'VIDEO'; value: number | null; preview: CmsMedia | null; onChange: (id: number | null) => void; error?: string | undefined; optional?: boolean;
}) {
  const { api } = useAuth();
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    const problem = kind === 'IMAGE' ? imageProblem(file) : null;
    if (problem) { toast.error(problem); return; }
    setBusy(true);
    try {
      const mediaId = kind === 'IMAGE' ? await uploadImage(api, file, 'cms-image') : await uploadVideo(api, file);
      setLocal(URL.createObjectURL(file));
      onChange(mediaId);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const shown = local ?? (preview && preview.id === value ? preview.url : null);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink-900">{label}{optional ? ' (optional)' : ''}</label>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        {value !== null && (shown
          ? (kind === 'VIDEO' ? <video src={shown} className="h-16 w-28 rounded-md bg-surface-100 object-cover" muted aria-label="Chosen video" /> : <img src={shown} alt="" className="h-16 w-28 rounded-md object-cover" />)
          : <span className="inline-flex h-16 w-28 items-center justify-center rounded-md bg-surface-100 text-xs text-ink-700">{preview?.status === 'REJECTED' ? 'Rejected' : 'Processing…'}</span>)}
        <input id={id} type="file" accept={kind === 'IMAGE' ? 'image/jpeg,image/png,image/webp,image/avif' : 'video/mp4,video/webm'} className="text-sm" disabled={busy}
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        {busy && <span role="status" className="text-sm text-ink-700">Uploading…</span>}
        {optional && value !== null && <button type="button" className={`${small} text-ink-900 hover:bg-surface-100`} onClick={() => { setLocal(null); onChange(null); }}>Remove</button>}
      </div>
      {error && <p id={`${id}-error`} className="mt-1 text-sm text-danger-700">{error}</p>}
    </div>
  );
}

/** Rows in their display order: move up / down (saved at once), edit, delete (confirmed), with an on/off state. */
export function OrderedList<T extends { id: number; isActive: boolean }>({ caption, rows, render, onMove, onEdit, onDelete, name, empty }: {
  caption: string; rows: T[]; render: (row: T) => ReactNode; name: (row: T) => string; empty: string;
  onMove: (ids: number[]) => Promise<void>; onEdit: (row: T) => void; onDelete: (row: T) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const move = async (i: number, d: -1 | 1) => {
    const ids = rows.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    setBusy(true);
    try { await onMove(ids); } finally { setBusy(false); }
  };
  if (rows.length === 0) return <p className="text-sm text-ink-700">{empty}</p>;
  return (
    <>
      <ol aria-label={caption} className="divide-y divide-surface-100 rounded-lg border border-surface-200 bg-white">
        {rows.map((r, i) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 p-3">
            <div className="flex flex-col gap-1">
              <button type="button" className={`${small} px-2`} aria-label={`Move ${name(r)} up`} disabled={busy || i === 0} onClick={() => void move(i, -1)}><ArrowUp size={16} aria-hidden /></button>
              <button type="button" className={`${small} px-2`} aria-label={`Move ${name(r)} down`} disabled={busy || i === rows.length - 1} onClick={() => void move(i, 1)}><ArrowDown size={16} aria-hidden /></button>
            </div>
            <div className="min-w-0 flex-1">{render(r)}</div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${r.isActive ? 'bg-[#dcfce7] text-success-700' : 'bg-surface-100 text-ink-700'}`}>{r.isActive ? 'Shown' : 'Hidden'}</span>
            <button type="button" className={`${small} border border-border-input bg-white`} aria-label={`Edit ${name(r)}`} onClick={() => onEdit(r)}>Edit</button>
            <button type="button" className={`${small} text-danger-700 hover:bg-[#fee2e2]`} aria-label={`Delete ${name(r)}`} onClick={() => setDeleting(r)}>Delete</button>
          </li>
        ))}
      </ol>
      <ConfirmDialog open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null); }} title="Delete this item?" description={deleting ? `“${name(deleting)}” is removed from the site. This can’t be undone.` : ''}
        confirmLabel="Delete" danger busy={busy} onConfirm={() => { const d = deleting; if (!d) return; setBusy(true); void onDelete(d).finally(() => { setBusy(false); setDeleting(null); }); }} />
    </>
  );
}

/** "" ↔ null for optional text inputs. */
export const text = (v: string | null | undefined) => v ?? '';
