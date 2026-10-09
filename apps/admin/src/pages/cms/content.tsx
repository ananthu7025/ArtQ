// Hero slides, reels, testimonials and FAQs (task 6.1): each an ordered list with an editor dialog checked by the
// shared schema (slideBody, reelBody, testimonialBody, faqBody); the server's refusals land on their field.
import {
  FAQ_GROUP_LABEL, FAQ_GROUPS, faqBody, reelBody, slideBody, testimonialBody,
  type CmsFaq, type CmsReel, type CmsSlide, type CmsTestimonial,
} from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm, type FieldValues, type Path, type UseFormSetError } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { useAuth } from '../../auth/AuthProvider';
import { FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, SelectField, TextField } from '../../components/form';
import { convertedForm } from '../../components/form-schema';
import { MediaField, OrderedList, primary, quiet, text } from './parts';

type Kind = 'slides' | 'reels' | 'testimonials' | 'faqs';
const PATH: Record<Kind, string> = { slides: '/admin/home-slides', reels: '/admin/reels', testimonials: '/admin/testimonials', faqs: '/admin/faqs' };

function useList<T>(k: Kind) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cms', k], queryFn: () => api.request<{ data: T[] }>('GET', PATH[k]) });
  const set = (data: T[]) => qc.setQueryData(['cms', k], { data });
  const move = async (ids: number[]) => {
    try { set((await api.request<{ data: T[] }>('PATCH', `${PATH[k]}/reorder`, { body: { ids } })).data); } catch (e) { toast.error(errorMessage(e)); void q.refetch(); }
  };
  const remove = async (id: number) => {
    try { set((await api.request<{ data: T[] }>('DELETE', `${PATH[k]}/${id}`)).data); toast.success('Deleted'); } catch (e) { toast.error(errorMessage(e)); void q.refetch(); }
  };
  return { q, set, move, remove };
}

/** Saves the editor's body (create or update) and returns the new list; field refusals land on the form. */
function useSave<T, F extends FieldValues>(k: Kind, setError: UseFormSetError<F>, fields: readonly Path<F>[], done: (data: T[]) => void) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (id: number | null, body: unknown) => {
    setProblem(null);
    try {
      const r = await api.request<{ data: T[] }>(id === null ? 'POST' : 'PUT', id === null ? PATH[k] : `${PATH[k]}/${id}`, { body });
      toast.success('Saved'); done(r.data);
    } catch (e) { if (!applyServerErrors(e, setError, fields)) setProblem(errorMessage(e)); }
  };
  return { save, problem };
}

function Shell<T extends { id: number; isActive: boolean }>({ k, title, intro, addLabel, render, name, editor }: {
  k: Kind; title: string; intro: string; addLabel: string; render: (r: T) => React.ReactNode; name: (r: T) => string;
  editor: (row: T | null, close: () => void, done: (data: T[]) => void) => React.ReactNode;
}) {
  const { q, set, move, remove } = useList<T>(k);
  const [editing, setEditing] = useState<T | null | 'new'>(null);
  return (
    <section aria-labelledby={`${k}-h`} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 id={`${k}-h`} className="text-lg font-semibold text-ink-900">{title}</h2><p className="text-sm text-ink-700">{intro}</p></div>
        <button type="button" className={primary} onClick={() => setEditing('new')}>{addLabel}</button>
      </div>
      {q.isPending ? <p role="status" className="text-ink-700">Loading…</p> : q.isError ? <FormAlert>{errorMessage(q.error)}</FormAlert>
        : <OrderedList caption={title} rows={q.data.data} render={render} name={name} empty="Nothing here yet." onMove={move} onEdit={(r) => setEditing(r)} onDelete={(r) => remove(r.id)} />}
      {editing !== null && editor(editing === 'new' ? null : editing, () => setEditing(null), (data) => { set(data); setEditing(null); })}
    </section>
  );
}

// ── Slides ──
type SlideForm = { heading: string; subheading: string; ctaText: string; ctaLink: string; mediaId: number | null; mobileMediaId: number | null; isActive: boolean; startsAt: string; endsAt: string };
/** datetime-local (India time) ↔ ISO with +05:30. */
const toIso = (v: string) => (v ? `${v}:00+05:30` : null);
const fromIso = (v: string | null) => (v ? new Date(new Date(v).getTime() + 5.5 * 3_600_000).toISOString().slice(0, 16) : '');
const slideForm = convertedForm<SlideForm, typeof slideBody>(() => [], (v) => ({ ...v, mediaId: v.mediaId ?? undefined, startsAt: toIso(v.startsAt), endsAt: toIso(v.endsAt) }), slideBody);
const SLIDE_FIELDS = ['heading', 'subheading', 'ctaText', 'ctaLink', 'mediaId', 'mobileMediaId', 'startsAt', 'endsAt'] as const;

export function SlidesTab() {
  return <Shell<CmsSlide> k="slides" title="Hero slides" intro="The large images at the top of the home page, in this order. A slide shows between its start and end." addLabel="Add slide"
    name={(s) => s.heading ?? `Slide ${s.id}`}
    render={(s) => <div className="flex items-center gap-3">{s.media.url ? <img src={s.media.url} alt="" className="h-12 w-20 rounded object-cover" /> : <span className="h-12 w-20 rounded bg-surface-100" />}
      <div className="min-w-0"><p className="truncate font-medium text-ink-900">{s.heading ?? 'No heading'}</p><p className="text-sm text-ink-700">{s.live ? 'On the home page now' : !s.isActive ? 'Hidden' : 'Not showing (scheduled, ended or image not ready)'}{s.ctaLink ? ` · ${s.ctaText} → ${s.ctaLink}` : ''}</p></div></div>}
    editor={(row, close, done) => <SlideEditor row={row} close={close} done={done} />} />;
}

function SlideEditor({ row, close, done }: { row: CmsSlide | null; close: () => void; done: (d: CmsSlide[]) => void }) {
  const form = useForm<SlideForm, unknown, ReturnType<typeof slideForm.parse>>({ resolver: zodResolver(slideForm), defaultValues: {
    heading: text(row?.heading), subheading: text(row?.subheading), ctaText: text(row?.ctaText), ctaLink: text(row?.ctaLink), mediaId: row?.media.id ?? null, mobileMediaId: row?.mobileMedia?.id ?? null,
    isActive: row?.isActive ?? true, startsAt: fromIso(row?.startsAt ?? null), endsAt: fromIso(row?.endsAt ?? null) } });
  const { save, problem } = useSave<CmsSlide, SlideForm>('slides', form.setError, SLIDE_FIELDS, done);
  const e = form.formState.errors;
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) close(); }} title={row ? 'Edit slide' : 'Add slide'}>
      <form noValidate onSubmit={form.handleSubmit((b) => save(row?.id ?? null, b))} className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        <Controller control={form.control} name="mediaId" render={({ field }) => <MediaField id="sl-media" label="Image (wide, at least 1600 px)" value={field.value} preview={row?.media ?? null} onChange={field.onChange} error={e.mediaId?.message} />} />
        <Controller control={form.control} name="mobileMediaId" render={({ field }) => <MediaField id="sl-mobile" label="Phone image" optional value={field.value} preview={row?.mobileMedia ?? null} onChange={field.onChange} error={e.mobileMediaId?.message} />} />
        <TextField id="sl-heading" label="Heading (optional)" {...form.register('heading')} error={e.heading?.message} />
        <TextField id="sl-sub" label="Subheading (optional)" {...form.register('subheading')} error={e.subheading?.message} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id="sl-cta" label="Button text (optional)" {...form.register('ctaText')} error={e.ctaText?.message} />
          <TextField id="sl-link" label="Button link" placeholder="/shop" {...form.register('ctaLink')} error={e.ctaLink?.message} />
          <TextField id="sl-start" label="Show from (optional)" type="datetime-local" {...form.register('startsAt')} error={e.startsAt?.message} />
          <TextField id="sl-end" label="Show until (optional)" type="datetime-local" {...form.register('endsAt')} error={e.endsAt?.message} />
        </div>
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5 accent-brand-700" {...form.register('isActive')} />Show on the home page</label>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3"><button type="button" className={quiet} onClick={close}>Cancel</button><button type="submit" className={primary} disabled={form.formState.isSubmitting}>Save slide</button></div>
      </form>
    </FormDialog>
  );
}

// ── Reels ──
type ReelForm = { title: string; videoMediaId: number | null; thumbnailMediaId: number | null; productId: string; instagramUrl: string; isActive: boolean };
const reelForm = convertedForm<ReelForm, typeof reelBody>(() => [], (v) => ({ ...v, videoMediaId: v.videoMediaId ?? undefined, productId: v.productId ? Number(v.productId) : null }), reelBody);

export function ReelsTab() {
  return <Shell<CmsReel> k="reels" title="Reels" intro="Short videos in the home page’s reels strip, each optionally linked to a product." addLabel="Add reel"
    name={(r) => r.title ?? `Reel ${r.id}`}
    render={(r) => <div><p className="font-medium text-ink-900">{r.title ?? 'Untitled reel'}</p><p className="text-sm text-ink-700">{r.video.url ? 'Video ready' : 'Video processing'}{r.product ? ` · ${r.product.name}` : ''}</p></div>}
    editor={(row, close, done) => <ReelEditor row={row} close={close} done={done} />} />;
}

function ReelEditor({ row, close, done }: { row: CmsReel | null; close: () => void; done: (d: CmsReel[]) => void }) {
  const { api } = useAuth();
  const products = useQuery({ queryKey: ['cms-products'], queryFn: () => api.request<{ data: { id: number; name: string }[] }>('GET', '/admin/products', { query: { limit: 100, status: 'ACTIVE' } }), staleTime: 60_000 });
  const form = useForm<ReelForm, unknown, ReturnType<typeof reelForm.parse>>({ resolver: zodResolver(reelForm), defaultValues: {
    title: text(row?.title), videoMediaId: row?.video.id ?? null, thumbnailMediaId: row?.thumbnail?.id ?? null, productId: row?.product ? String(row.product.id) : '', instagramUrl: text(row?.instagramUrl), isActive: row?.isActive ?? true } });
  const { save, problem } = useSave<CmsReel, ReelForm>('reels', form.setError, ['title', 'videoMediaId', 'thumbnailMediaId', 'productId', 'instagramUrl'], done);
  const e = form.formState.errors;
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) close(); }} title={row ? 'Edit reel' : 'Add reel'}>
      <form noValidate onSubmit={form.handleSubmit((b) => save(row?.id ?? null, b))} className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        <Controller control={form.control} name="videoMediaId" render={({ field }) => <MediaField id="re-video" kind="VIDEO" label="Video (MP4 or WebM, up to 50 MB)" value={field.value} preview={row?.video ?? null} onChange={field.onChange} error={e.videoMediaId?.message} />} />
        <Controller control={form.control} name="thumbnailMediaId" render={({ field }) => <MediaField id="re-thumb" label="Cover image" optional value={field.value} preview={row?.thumbnail ?? null} onChange={field.onChange} error={e.thumbnailMediaId?.message} />} />
        <TextField id="re-title" label="Title (optional)" {...form.register('title')} error={e.title?.message} />
        <SelectField id="re-product" label="Product shown with it (optional)" {...form.register('productId')} error={e.productId?.message}>
          <option value="">None</option>
          {row?.product && !(products.data?.data ?? []).some((p) => p.id === row.product!.id) && <option value={row.product.id}>{row.product.name}</option>}
          {(products.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SelectField>
        <TextField id="re-insta" label="Instagram link (optional)" placeholder="https://www.instagram.com/reel/…" {...form.register('instagramUrl')} error={e.instagramUrl?.message} />
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5 accent-brand-700" {...form.register('isActive')} />Show on the home page</label>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3"><button type="button" className={quiet} onClick={close}>Cancel</button><button type="submit" className={primary} disabled={form.formState.isSubmitting}>Save reel</button></div>
      </form>
    </FormDialog>
  );
}

// ── Testimonials ──
type TestimonialForm = { name: string; location: string; quote: string; rating: string; avatarMediaId: number | null; productId: null; isActive: boolean };
const testimonialForm = convertedForm<TestimonialForm, typeof testimonialBody>(() => [], (v) => ({ ...v, rating: v.rating ? Number(v.rating) : undefined }), testimonialBody);

export function TestimonialsTab() {
  return <Shell<CmsTestimonial> k="testimonials" title="Testimonials" intro="What customers said, shown on the home page." addLabel="Add testimonial"
    name={(t) => t.name}
    render={(t) => <div><p className="font-medium text-ink-900">{t.name}{t.location ? `, ${t.location}` : ''} · {'★'.repeat(t.rating)}<span className="sr-only"> {t.rating} out of 5</span></p><p className="line-clamp-2 text-sm text-ink-700">{t.quote}</p></div>}
    editor={(row, close, done) => <TestimonialEditor row={row} close={close} done={done} />} />;
}

function TestimonialEditor({ row, close, done }: { row: CmsTestimonial | null; close: () => void; done: (d: CmsTestimonial[]) => void }) {
  const form = useForm<TestimonialForm, unknown, ReturnType<typeof testimonialForm.parse>>({ resolver: zodResolver(testimonialForm), defaultValues: {
    name: text(row?.name), location: text(row?.location), quote: text(row?.quote), rating: row ? String(row.rating) : '5', avatarMediaId: row?.avatar?.id ?? null, productId: null, isActive: row?.isActive ?? true } });
  const { save, problem } = useSave<CmsTestimonial, TestimonialForm>('testimonials', form.setError, ['name', 'location', 'quote', 'rating', 'avatarMediaId'], done);
  const e = form.formState.errors;
  const qErr = e.quote?.message;
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) close(); }} title={row ? 'Edit testimonial' : 'Add testimonial'}>
      <form noValidate onSubmit={form.handleSubmit((b) => save(row?.id ?? null, b))} className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id="te-name" label="Name" {...form.register('name')} error={e.name?.message} />
          <TextField id="te-loc" label="Place (optional)" placeholder="Kochi" {...form.register('location')} error={e.location?.message} />
        </div>
        <div>
          <label htmlFor="te-quote" className="block text-sm font-medium text-ink-900">What they said</label>
          <textarea id="te-quote" rows={4} className="mt-1 block w-full rounded-md border border-border-input p-2 text-sm" aria-invalid={qErr ? true : undefined} aria-describedby={qErr ? 'te-quote-error' : undefined} {...form.register('quote')} />
          {qErr && <p id="te-quote-error" className="mt-1 text-sm text-danger-700">{qErr}</p>}
        </div>
        <SelectField id="te-rating" label="Rating" {...form.register('rating')} error={e.rating?.message}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n === 1 ? '' : 's'}</option>)}</SelectField>
        <Controller control={form.control} name="avatarMediaId" render={({ field }) => <MediaField id="te-avatar" label="Photo" optional value={field.value} preview={row?.avatar ?? null} onChange={field.onChange} error={e.avatarMediaId?.message} />} />
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5 accent-brand-700" {...form.register('isActive')} />Show on the home page</label>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3"><button type="button" className={quiet} onClick={close}>Cancel</button><button type="submit" className={primary} disabled={form.formState.isSubmitting}>Save testimonial</button></div>
      </form>
    </FormDialog>
  );
}

// ── FAQs (ordered within each group) ──
export function FaqsTab() {
  const { q, set, move, remove } = useList<CmsFaq>('faqs');
  const [editing, setEditing] = useState<CmsFaq | null | 'new'>(null);
  return (
    <section aria-labelledby="faqs-h" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 id="faqs-h" className="text-lg font-semibold text-ink-900">FAQs</h2><p className="text-sm text-ink-700">Questions on the FAQ page, by group, in this order.</p></div>
        <button type="button" className={primary} onClick={() => setEditing('new')}>Add question</button>
      </div>
      {q.isPending ? <p role="status" className="text-ink-700">Loading…</p> : q.isError ? <FormAlert>{errorMessage(q.error)}</FormAlert> : FAQ_GROUPS.map((g) => {
        const rows = q.data.data.filter((f) => f.group === g);
        return (
          <div key={g} className="space-y-2">
            <h3 className="font-semibold text-ink-900">{FAQ_GROUP_LABEL[g]}</h3>
            <OrderedList caption={`${FAQ_GROUP_LABEL[g]} questions`} rows={rows} name={(f) => f.question} empty="No questions in this group." onMove={move} onEdit={(f) => setEditing(f)} onDelete={(f) => remove(f.id)}
              render={(f) => <div><p className="font-medium text-ink-900">{f.question}</p><p className="line-clamp-2 text-sm text-ink-700">{f.answer}</p></div>} />
          </div>
        );
      })}
      {editing !== null && <FaqEditor row={editing === 'new' ? null : editing} close={() => setEditing(null)} done={(d) => { set(d); setEditing(null); }} />}
    </section>
  );
}

function FaqEditor({ row, close, done }: { row: CmsFaq | null; close: () => void; done: (d: CmsFaq[]) => void }) {
  const form = useForm<z.input<typeof faqBody>, unknown, z.output<typeof faqBody>>({ resolver: zodResolver(faqBody), defaultValues: { group: row?.group ?? 'ORDERS', question: text(row?.question), answer: text(row?.answer), isActive: row?.isActive ?? true } });
  const { save, problem } = useSave<CmsFaq, z.input<typeof faqBody>>('faqs', form.setError, ['group', 'question', 'answer'], done);
  const e = form.formState.errors;
  const aErr = e.answer?.message;
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) close(); }} title={row ? 'Edit question' : 'Add question'}>
      <form noValidate onSubmit={form.handleSubmit((b) => save(row?.id ?? null, b))} className="space-y-3">
        <SelectField id="fq-group" label="Group" {...form.register('group')} error={e.group?.message}>{FAQ_GROUPS.map((g) => <option key={g} value={g}>{FAQ_GROUP_LABEL[g]}</option>)}</SelectField>
        <TextField id="fq-q" label="Question" {...form.register('question')} error={e.question?.message} />
        <div>
          <label htmlFor="fq-a" className="block text-sm font-medium text-ink-900">Answer</label>
          <textarea id="fq-a" rows={5} className="mt-1 block w-full rounded-md border border-border-input p-2 text-sm" aria-invalid={aErr ? true : undefined} aria-describedby={aErr ? 'fq-a-error' : undefined} {...form.register('answer')} />
          {aErr && <p id="fq-a-error" className="mt-1 text-sm text-danger-700">{aErr}</p>}
        </div>
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5 accent-brand-700" {...form.register('isActive')} />Show on the FAQ page</label>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3"><button type="button" className={quiet} onClick={close}>Cancel</button><button type="submit" className={primary} disabled={form.formState.isSubmitting}>Save question</button></div>
      </form>
    </FormDialog>
  );
}
