'use client';
// Contact and custom-work forms (task 6.2; product.md §5.11). Both check the shared schema (contactBody,
// customWorkBody) under each field, send JSON, put the server's refusals on their field, and thank the visitor (a copy
// of the acknowledgement goes to their email). Custom work takes up to 4 photos: each is uploaded straight to storage,
// then checked and resized by the server; Send waits until they are ready.
import { contactBody, CUSTOM_WORK_PHOTOS_MAX, customWorkBody, type ContactInput } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError } from '../../lib/api';
import { applyServerErrors, FormAlert, primaryButton, secondaryButton, TextField } from '../form/fields';
import { useApi } from '../shop/ShopProvider';

const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

function TextArea({ id, label, error, ...rest }: { id: string; label: string; error?: string | undefined } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink-900">{label}</label>
      <textarea id={id} rows={5} className="mt-1 block w-full rounded-md border border-border-input bg-white p-3 text-ink-900" aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} {...rest} />
      {error && <p id={`${id}-error`} className="mt-1 text-sm text-danger-700">{error}</p>}
    </div>
  );
}

function Thanks({ title, text, onAgain }: { title: string; text: string; onAgain: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div ref={ref} tabIndex={-1} role="status" className="rounded-lg border border-surface-200 bg-surface-100 p-6 outline-none">
      <h2 className="text-lg font-semibold text-ink-900">{title}</h2>
      <p className="mt-2 text-ink-800">{text}</p>
      <button type="button" className={`${secondaryButton} mt-4`} onClick={onAgain}>Send another</button>
    </div>
  );
}

export function ContactForm() {
  const api = useApi();
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const form = useForm<ContactInput, unknown, z.output<typeof contactBody>>({ resolver: zodResolver(contactBody), defaultValues: { name: '', email: '', phone: '', subject: '', message: '', orderNumber: '' } });
  const e = form.formState.errors;
  const save = form.handleSubmit(async (body) => {
    setProblem(null);
    try { await api('POST', '/contact', body); setDone(true); form.reset(); }
    catch (err) { if (!applyServerErrors(err, form.setError, ['name', 'email', 'phone', 'subject', 'message', 'orderNumber'])) setProblem(err instanceof ApiError && err.code === 'RATE_LIMITED' ? 'You’ve sent a few messages just now. Please wait a minute and try again.' : message(err)); }
  });
  if (done) return <Thanks title="Thank you, we’ve got your message" text="We usually reply within 1 working day. A copy is on its way to your email." onAgain={() => setDone(false)} />;
  return (
    <form noValidate onSubmit={(ev) => { void save(ev); }} className="space-y-4" aria-label="Contact us">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="ct-name" label="Your name" autoComplete="name" {...form.register('name')} error={e.name?.message} />
        <TextField id="ct-email" label="Email" type="email" autoComplete="email" {...form.register('email')} error={e.email?.message} />
        <TextField id="ct-phone" label="Phone (optional)" type="tel" autoComplete="tel" {...form.register('phone')} error={e.phone?.message} />
        <TextField id="ct-order" label="Order number (optional)" placeholder="AQ10234" {...form.register('orderNumber')} error={e.orderNumber?.message} />
      </div>
      <TextField id="ct-subject" label="Subject" {...form.register('subject')} error={e.subject?.message} />
      <TextArea id="ct-message" label="Message" {...form.register('message')} error={e.message?.message} />
      {problem && <FormAlert>{problem}</FormAlert>}
      <button type="submit" className={primaryButton} disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? 'Sending…' : 'Send message'}</button>
    </form>
  );
}

type Photo = { key: string; name: string; id: number | null; status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED'; error?: string };
/** Text inputs for the numbers; converted for the shared schema (empty → null, digits → number, else NaN so it says why). */
type CustomForm = { name: string; email: string; phone: string; size: string; wood: string; quantity: string; budget: string; neededBy: string; message: string };
const num = (s: string) => (s.trim() === '' ? null : /^\d+$/.test(s.trim()) ? Number(s.trim()) : Number.NaN);

export function CustomWorkForm() {
  const api = useApi();
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const toBody = (v: CustomForm) => ({ name: v.name, email: v.email, phone: v.phone, message: v.message, details: { size: v.size, wood: v.wood, quantity: num(v.quantity), budget: num(v.budget), neededBy: v.neededBy },
    attachmentMediaIds: photos.filter((p) => p.status === 'READY' && p.id !== null).map((p) => p.id!) });
  const resolver = zodResolver(z.custom<CustomForm>().transform((v, ctx) => {
    const r = customWorkBody.safeParse(toBody(v));
    if (r.success) return r.data;
    for (const i of r.error.issues) ctx.addIssue({ code: 'custom', message: i.message, path: i.path[0] === 'details' ? [String(i.path[1])] : [String(i.path[0] ?? '')] });
    return z.NEVER;
  }));
  const form = useForm<CustomForm, unknown, z.output<typeof customWorkBody>>({ resolver: resolver as never, defaultValues: { name: '', email: '', phone: '', size: '', wood: '', quantity: '', budget: '', neededBy: '', message: '' } });
  const e = form.formState.errors as Record<string, { message?: string } | undefined>;
  const busy = photos.some((p) => p.status === 'UPLOADING' || p.status === 'PROCESSING');

  const upload = async (file: File) => {
    const key = `${file.name}-${Date.now()}`;
    const update = (patch: Partial<Photo>) => setPhotos((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
    setPhotos((ps) => [...ps, { key, name: file.name, id: null, status: 'UPLOADING' }]);
    try {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.type)) throw new Error('Use a JPEG, PNG, WebP or AVIF photo');
      if (file.size > 8 * 1024 * 1024) throw new Error('Photos can be at most 8 MB');
      const p = await api<{ media: { id: number }; upload: { url: string; headers: Record<string, string> } }>('POST', '/uploads/presign', { filename: file.name, contentType: file.type, size: file.size });
      const put = await fetch(p.upload.url, { method: 'PUT', body: file, headers: { 'Content-Type': p.upload.headers['Content-Type'] ?? file.type } });
      if (!put.ok) throw new Error('The upload failed. Try again.');
      await api('POST', `/uploads/${p.media.id}/complete`, {});
      update({ id: p.media.id, status: 'PROCESSING' });
      for (let i = 0; i < 40 && live.current; i++) {
        const { media } = await api<{ media: { status: string } }>('GET', `/uploads/${p.media.id}`);
        if (media.status === 'READY') { update({ status: 'READY' }); return; }
        if (media.status === 'REJECTED') throw new Error('This file isn’t a photo we can use.');
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error('The photo is taking too long. Try again.');
    } catch (err) { update({ status: 'FAILED', error: message(err) }); }
  };

  const save = form.handleSubmit(async (body) => {
    setProblem(null);
    try { await api('POST', '/custom-work', body); setDone(true); form.reset(); setPhotos([]); }
    catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) for (const d of err.details as { path?: string }[]) if (d.path?.startsWith('details.')) d.path = d.path.slice('details.'.length);
      if (!applyServerErrors(err, form.setError, ['name', 'email', 'phone', 'size', 'wood', 'quantity', 'budget', 'neededBy', 'message', 'attachmentMediaIds' as never])) setProblem(err instanceof ApiError && err.code === 'RATE_LIMITED' ? 'You’ve sent a few requests just now. Please wait a minute and try again.' : message(err));
    }
  });
  if (done) return <Thanks title="Thank you, we’ve got your request" text="We’ll look at your idea and photos and reply with options and a price, usually within 2 working days. A copy is on its way to your email." onAgain={() => setDone(false)} />;
  const photoErr = e.attachmentMediaIds?.message;
  return (
    <form noValidate onSubmit={(ev) => { void save(ev); }} className="space-y-4" aria-label="Custom work request">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="cw-name" label="Your name" autoComplete="name" {...form.register('name')} error={e.name?.message} />
        <TextField id="cw-phone" label="Phone" type="tel" autoComplete="tel" {...form.register('phone')} error={e.phone?.message} />
        <TextField id="cw-email" label="Email" type="email" autoComplete="email" className="sm:col-span-2" {...form.register('email')} error={e.email?.message} />
        <TextField id="cw-size" label="Size (optional)" placeholder="e.g. A3 or 12 × 16 in" {...form.register('size')} error={e.size?.message} />
        <TextField id="cw-wood" label="Wood or finish (optional)" placeholder="e.g. Teak" {...form.register('wood')} error={e.wood?.message} />
        <TextField id="cw-qty" label="How many (optional)" inputMode="numeric" {...form.register('quantity')} error={e.quantity?.message} />
        <TextField id="cw-budget" label="Budget in ₹ (optional)" inputMode="numeric" {...form.register('budget')} error={e.budget?.message} />
        <TextField id="cw-date" label="Needed by (optional)" type="date" {...form.register('neededBy')} error={e.neededBy?.message} />
      </div>
      <TextArea id="cw-message" label="Tell us what you’d like" placeholder="Flowers from our wedding, preserved in a frame for our living room…" {...form.register('message')} error={e.message?.message} />
      <div>
        <label htmlFor="cw-photos" className="block text-sm font-medium text-ink-900">Photos (optional, up to {CUSTOM_WORK_PHOTOS_MAX})</label>
        <input id="cw-photos" type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple disabled={photos.length >= CUSTOM_WORK_PHOTOS_MAX} className="mt-1 block text-sm"
          aria-invalid={photoErr ? true : undefined} aria-describedby={photoErr ? 'cw-photos-error' : undefined}
          onChange={(ev) => { for (const f of Array.from(ev.target.files ?? []).slice(0, CUSTOM_WORK_PHOTOS_MAX - photos.length)) void upload(f); ev.target.value = ''; }} />
        {photoErr && <p id="cw-photos-error" className="mt-1 text-sm text-danger-700">{photoErr}</p>}
        {photos.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm" aria-live="polite">
            {photos.map((p) => <li key={p.key} className="flex items-center gap-3"><span className={p.status === 'FAILED' ? 'text-danger-700' : 'text-ink-700'}>{p.name}: {p.status === 'READY' ? 'ready' : p.status === 'FAILED' ? p.error : 'uploading…'}</span>
              <button type="button" className="text-sm font-medium text-brand-700 underline" onClick={() => setPhotos((ps) => ps.filter((x) => x.key !== p.key))} aria-label={`Remove ${p.name}`}>Remove</button></li>)}
          </ul>
        )}
      </div>
      {problem && <FormAlert>{problem}</FormAlert>}
      <button type="submit" className={primaryButton} disabled={form.formState.isSubmitting || busy}>{form.formState.isSubmitting ? 'Sending…' : busy ? 'Uploading photos…' : 'Send request'}</button>
    </form>
  );
}
