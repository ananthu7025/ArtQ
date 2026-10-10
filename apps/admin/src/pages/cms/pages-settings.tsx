// Content pages and home settings (task 6.1). Pages: about and the policy pages (fixed addresses used by the footer)
// plus any other page, written in the same rich-text editor as product descriptions (the API cleans it). Home settings:
// the announcement bar, home section order and visibility, hero timing, Instagram and social links, each saved on its
// own with the shared schema.
import {
  announcementBody, heroBody, HOME_SECTION_KEYS, homeSectionsBody, instagramBody, pageBody, POLICY_SLUGS, socialBody,
  type CmsPageDetail, type CmsPageRow,
} from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { useAuth } from '../../auth/AuthProvider';
import { ConfirmDialog, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, TextField } from '../../components/form';
import { convertedForm, wholeProblems } from '../../components/form-schema';
import { RichText } from '../products/editor/RichText';
import { when } from '../orders/labels';
import { card, outline, primary, quiet, small, text } from './parts';

const SECTION_LABEL: Record<(typeof HOME_SECTION_KEYS)[number], string> = { hero: 'Hero slides', types: 'Shop by type', 'new-arrivals': 'New arrivals', reels: 'Reels', trending: 'Trending', techniques: 'Techniques', testimonials: 'Testimonials', instagram: 'Instagram' };

export function PagesTab() {
  const { api } = useAuth();
  const q = useQuery({ queryKey: ['cms', 'pages'], queryFn: () => api.request<{ data: CmsPageRow[] }>('GET', '/admin/pages') });
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CmsPageRow | null>(null);
  const remove = async (p: CmsPageRow) => {
    try { await api.request('DELETE', `/admin/pages/${p.id}`); toast.success('Page deleted'); } catch (e) { toast.error(errorMessage(e)); }
    setDeleting(null); void q.refetch();
  };
  const fixed = (slug: string) => (POLICY_SLUGS as readonly string[]).includes(slug);
  return (
    <section aria-labelledby="pages-h" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 id="pages-h" className="text-lg font-semibold text-ink-900">Pages</h2><p className="text-sm text-ink-700">About, the policy pages linked from the footer, and any other page.</p></div>
        <button type="button" className={primary} onClick={() => setEditing('new')}>Add page</button>
      </div>
      {q.isPending ? <p role="status" className="text-ink-700">Loading…</p> : q.isError ? <FormAlert>{errorMessage(q.error)}</FormAlert> : q.data.data.length === 0 ? <p className="text-sm text-ink-700">No pages yet. Start with About and the policies.</p> : (
        <ul className="divide-y divide-surface-100 rounded-lg border border-surface-200 bg-white">
          {q.data.data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div><p className="font-medium text-ink-900">{p.title}</p><p className="text-sm text-ink-700"><span className="font-mono">/{p.slug}</span>{fixed(p.slug) ? ' · linked from the footer' : ''} · updated {when(p.updatedAt)}{p.updatedBy ? ` by ${p.updatedBy}` : ''}</p></div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${p.isPublished ? 'bg-[#dcfce7] text-success-700' : 'bg-surface-100 text-ink-700'}`}>{p.isPublished ? 'Published' : 'Draft'}</span>
                <button type="button" className={`${small} border border-border-input bg-white`} aria-label={`Edit ${p.title}`} onClick={() => setEditing(p.id)}>Edit</button>
                {!fixed(p.slug) && <button type="button" className={`${small} text-danger-700 hover:bg-[#fee2e2]`} aria-label={`Delete ${p.title}`} onClick={() => setDeleting(p)}>Delete</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing !== null && <PageEditor id={editing === 'new' ? null : editing} close={() => setEditing(null)} done={() => { setEditing(null); void q.refetch(); }} />}
      <ConfirmDialog open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null); }} title="Delete this page?" description={deleting ? `/${deleting.slug} will show “not found”.` : ''} confirmLabel="Delete" danger onConfirm={() => { if (deleting) void remove(deleting); }} />
    </section>
  );
}

function PageEditor({ id, close, done }: { id: number | null; close: () => void; done: () => void }) {
  const { api } = useAuth();
  const q = useQuery({ queryKey: ['cms', 'page', id], queryFn: () => api.request<CmsPageDetail>('GET', `/admin/pages/${id}`), enabled: id !== null });
  if (id !== null && q.isPending) return <FormDialog open onOpenChange={(o) => { if (!o) close(); }} title="Edit page"><p role="status">Loading…</p></FormDialog>;
  return <PageForm page={q.data ?? null} close={close} done={done} />;
}

function PageForm({ page, close, done }: { page: CmsPageDetail | null; close: () => void; done: () => void }) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const form = useForm<z.input<typeof pageBody>, unknown, z.output<typeof pageBody>>({ resolver: zodResolver(pageBody), defaultValues: {
    slug: page?.slug ?? '', title: page?.title ?? '', content: page?.content ?? '', metaTitle: text(page?.metaTitle), metaDescription: text(page?.metaDescription), isPublished: page?.isPublished ?? true } });
  const e = form.formState.errors;
  const save = form.handleSubmit(async (body) => {
    setProblem(null);
    try { await api.request(page ? 'PUT' : 'POST', page ? `/admin/pages/${page.id}` : '/admin/pages', { body }); toast.success('Page saved'); done(); }
    catch (err) { if (!applyServerErrors(err, form.setError, ['slug', 'title', 'content', 'metaTitle', 'metaDescription'])) setProblem(errorMessage(err)); }
  });
  const fixed = page !== null && (POLICY_SLUGS as readonly string[]).includes(page.slug);
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) close(); }} title={page ? `Edit ${page.title}` : 'Add page'}>
      <form noValidate onSubmit={(ev) => { void save(ev); }} className="max-h-[75vh] space-y-3 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id="pg-title" label="Title" {...form.register('title')} error={e.title?.message} />
          <TextField id="pg-slug" label="Address" hint={fixed ? 'Used by the footer; it can’t change' : 'The page is shown at /address'} readOnly={fixed} {...form.register('slug')} error={e.slug?.message} />
        </div>
        <Controller control={form.control} name="content" render={({ field }) => <RichText id="pg-content" label="Page text" value={field.value} onChange={field.onChange} error={e.content?.message} />} />
        <TextField id="pg-mt" label="Search title (optional)" {...form.register('metaTitle')} error={e.metaTitle?.message} />
        <TextField id="pg-md" label="Search description (optional)" {...form.register('metaDescription')} error={e.metaDescription?.message} />
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5 accent-brand-700" {...form.register('isPublished')} />Published</label>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3"><button type="button" className={quiet} onClick={close}>Cancel</button><button type="submit" className={primary} disabled={form.formState.isSubmitting}>Save page</button></div>
      </form>
    </FormDialog>
  );
}

// ── Home settings ──
type Settings = { ANNOUNCEMENT_BAR: z.output<typeof announcementBody> | null; HOME_SECTIONS: z.output<typeof homeSectionsBody> | null; HERO: { slideIntervalMs: number } | null;
  INSTAGRAM_MOMENTS: { enabled: boolean; handle: string | null } | null; SOCIAL: z.output<typeof socialBody> | null };

export function HomeSettingsTab() {
  const { api } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cms', 'settings'], queryFn: () => api.request<Settings>('GET', '/admin/cms/settings') });
  if (q.isPending) return <p role="status" className="text-ink-700">Loading…</p>;
  if (q.isError) return <FormAlert>{errorMessage(q.error)}</FormAlert>;
  const saved = (s: Settings) => { qc.setQueryData(['cms', 'settings'], s); toast.success('Saved. The site shows it within a few minutes.'); };
  return (
    <div className="space-y-5">
      <Announcement value={q.data.ANNOUNCEMENT_BAR} onSaved={saved} />
      <Sections value={q.data.HOME_SECTIONS} onSaved={saved} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Hero value={q.data.HERO} onSaved={saved} />
        <Instagram value={q.data.INSTAGRAM_MOMENTS} onSaved={saved} />
      </div>
      <Social value={q.data.SOCIAL} onSaved={saved} />
    </div>
  );
}

function Box({ id, title, intro, children }: { id: string; title: string; intro: string; children: ReactNode }) {
  return <section aria-labelledby={id} className={card}><h2 id={id} className="font-semibold text-ink-900">{title}</h2><p className="mb-3 text-sm text-ink-700">{intro}</p>{children}</section>;
}
function useSetting(key: string, onSaved: (s: Settings) => void) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  return { problem, put: async (body: unknown, onFieldErrors: (e: unknown) => boolean) => {
    setProblem(null);
    try { onSaved(await api.request<Settings>('PUT', `/admin/settings/${key}`, { body })); } catch (e) { if (!onFieldErrors(e)) setProblem(errorMessage(e)); }
  } };
}

type AnnouncementForm = { enabled: boolean; messages: { text: string }[] };
/** The form keeps each message as `{text}` (a field array); the shared schema checks the body built from it. */
const announcementForm = convertedForm<AnnouncementForm, typeof announcementBody>(() => [], (v) => ({ enabled: v.enabled, messages: v.messages.map((m) => m.text) }), announcementBody,
  (p) => (p[0] === 'messages' && typeof p[1] === 'number' ? ['messages', p[1], 'text'] : p));

function Announcement({ value, onSaved }: { value: Settings['ANNOUNCEMENT_BAR']; onSaved: (s: Settings) => void }) {
  const form = useForm<AnnouncementForm, unknown, z.output<typeof announcementBody>>({ resolver: zodResolver(announcementForm), defaultValues: { enabled: value?.enabled ?? true, messages: (value?.messages ?? []).map((t) => ({ text: t })) } });
  const list = useFieldArray({ control: form.control, name: 'messages' });
  const { put, problem } = useSetting('ANNOUNCEMENT_BAR', onSaved);
  const save = form.handleSubmit((b) => put(b, (e) => applyServerErrors(e, form.setError, ['messages'])));
  const listErr = (form.formState.errors.messages as { message?: string; root?: { message?: string } } | undefined);
  return (
    <Box id="ann-h" title="Announcement bar" intro="The strip at the very top of every page. Up to 5 messages, shown one after another.">
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-3">
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5 accent-brand-700" {...form.register('enabled')} />Show the bar</label>
        {list.fields.map((f, i) => (
          <div key={f.id} className="flex items-start gap-2">
            <TextField id={`ann-${i}`} label={`Message ${i + 1}`} className="flex-1" {...form.register(`messages.${i}.text`)} error={form.formState.errors.messages?.[i]?.text?.message} />
            <button type="button" className={`${small} mt-6 text-danger-700 hover:bg-[#fee2e2]`} aria-label={`Remove message ${i + 1}`} onClick={() => list.remove(i)}>Remove</button>
          </div>
        ))}
        {(listErr?.message || listErr?.root?.message) && <p className="text-sm text-danger-700">{listErr.message ?? listErr.root?.message}</p>}
        <div className="flex flex-wrap gap-3">
          {list.fields.length < 5 && <button type="button" className={outline} onClick={() => list.append({ text: '' })}>Add message</button>}
          <button type="submit" className={primary} disabled={form.formState.isSubmitting}>Save announcement</button>
        </div>
        {problem && <FormAlert>{problem}</FormAlert>}
      </form>
    </Box>
  );
}

function Sections({ value, onSaved }: { value: Settings['HOME_SECTIONS']; onSaved: (s: Settings) => void }) {
  const known = new Set<string>(HOME_SECTION_KEYS);
  const start = [...(value?.order ?? []).filter((k) => known.has(k)), ...HOME_SECTION_KEYS.filter((k) => !(value?.order ?? []).includes(k))] as (typeof HOME_SECTION_KEYS)[number][];
  const [order, setOrder] = useState(start);
  const [hidden, setHidden] = useState<string[]>(value?.hidden ?? []);
  const [error, setError] = useState<string | null>(null);
  const { put, problem } = useSetting('HOME_SECTIONS', onSaved);
  const move = (i: number, d: -1 | 1) => { const o = [...order]; [o[i], o[i + d]] = [o[i + d]!, o[i]!]; setOrder(o); };
  const save = async () => {
    const r = homeSectionsBody.safeParse({ order, hidden });
    if (!r.success) { setError(r.error.issues[0]!.message); return; }
    setError(null);
    await put(r.data, () => false);
  };
  return (
    <Box id="sec-h" title="Home sections" intro="The order of the home page’s sections, and which are hidden. Sections with nothing to show stay hidden anyway.">
      <ol aria-label="Home sections in order" className="divide-y divide-surface-100 rounded-md border border-surface-200">
        {order.map((k, i) => (
          <li key={k} className="flex items-center gap-3 px-3 py-2 text-sm">
            <button type="button" className={`${small} px-2`} aria-label={`Move ${SECTION_LABEL[k]} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={16} aria-hidden /></button>
            <button type="button" className={`${small} px-2`} aria-label={`Move ${SECTION_LABEL[k]} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)}><ArrowDown size={16} aria-hidden /></button>
            <span className="flex-1">{SECTION_LABEL[k]}</span>
            {k !== 'hero' && <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-brand-700" checked={!hidden.includes(k)} onChange={(e) => setHidden(e.target.checked ? hidden.filter((h) => h !== k) : [...hidden, k])} />Shown</label>}
          </li>
        ))}
      </ol>
      {error && <p className="mt-2 text-sm text-danger-700">{error}</p>}
      {problem && <div className="mt-2"><FormAlert>{problem}</FormAlert></div>}
      <button type="button" className={`${primary} mt-3`} onClick={() => void save()}>Save sections</button>
    </Box>
  );
}

type HeroForm = { seconds: string };
/** Seconds in the form, milliseconds in the body; the shared rule's message lands on the seconds field. */
const heroForm = convertedForm<HeroForm, typeof heroBody>((v) => wholeProblems([[['seconds'], v.seconds]], 'Use whole seconds'), (v) => ({ slideIntervalMs: v.seconds.trim() ? Number(v.seconds) * 1000 : Number.NaN }), heroBody, (p) => (p[0] === 'slideIntervalMs' ? ['seconds'] : p));

function Hero({ value, onSaved }: { value: Settings['HERO']; onSaved: (s: Settings) => void }) {
  const form = useForm<HeroForm, unknown, z.output<typeof heroBody>>({ resolver: zodResolver(heroForm), defaultValues: { seconds: String(Math.round((value?.slideIntervalMs ?? 6000) / 1000)) } });
  const { put, problem } = useSetting('HERO', onSaved);
  return (
    <Box id="hero-h" title="Hero timing" intro="How long each hero slide stays before the next one (2 to 30 seconds).">
      <form noValidate onSubmit={form.handleSubmit((b) => put(b, () => false))} className="space-y-3">
        <TextField id="hero-s" label="Seconds per slide" inputMode="numeric" {...form.register('seconds')} error={form.formState.errors.seconds?.message} />
        {problem && <FormAlert>{problem}</FormAlert>}
        <button type="submit" className={primary}>Save timing</button>
      </form>
    </Box>
  );
}

function Instagram({ value, onSaved }: { value: Settings['INSTAGRAM_MOMENTS']; onSaved: (s: Settings) => void }) {
  const form = useForm<z.input<typeof instagramBody>, unknown, z.output<typeof instagramBody>>({ resolver: zodResolver(instagramBody), defaultValues: { enabled: value?.enabled ?? false, handle: value?.handle ?? '' } });
  const { put, problem } = useSetting('INSTAGRAM_MOMENTS', onSaved);
  const enabled = useWatch({ control: form.control, name: 'enabled' });
  return (
    <Box id="ig-h" title="Instagram moments" intro="A link to the shop’s Instagram at the end of the home page.">
      <form noValidate onSubmit={form.handleSubmit((b) => put(b, (e) => applyServerErrors(e, form.setError, ['handle'])))} className="space-y-3">
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5 accent-brand-700" {...form.register('enabled')} />Show the Instagram section</label>
        <TextField id="ig-handle" label={`Instagram handle${enabled ? '' : ' (optional)'}`} placeholder="@artq.studio" {...form.register('handle')} error={form.formState.errors.handle?.message} />
        {problem && <FormAlert>{problem}</FormAlert>}
        <button type="submit" className={primary}>Save Instagram</button>
      </form>
    </Box>
  );
}

function Social({ value, onSaved }: { value: Settings['SOCIAL']; onSaved: (s: Settings) => void }) {
  const form = useForm<z.input<typeof socialBody>, unknown, z.output<typeof socialBody>>({ resolver: zodResolver(socialBody), defaultValues: { instagram: value?.instagram ?? '', facebook: value?.facebook ?? '', youtube: value?.youtube ?? '', whatsapp: value?.whatsapp ?? '' } });
  const { put, problem } = useSetting('SOCIAL', onSaved);
  const e = form.formState.errors;
  return (
    <Box id="so-h" title="Social links" intro="Shown in the footer. Leave a field empty to hide that link.">
      <form noValidate onSubmit={form.handleSubmit((b) => put(b, (err) => applyServerErrors(err, form.setError, ['instagram', 'facebook', 'youtube', 'whatsapp'])))} className="grid gap-3 sm:grid-cols-2">
        <TextField id="so-ig" label="Instagram link" placeholder="https://www.instagram.com/…" {...form.register('instagram')} error={e.instagram?.message} />
        <TextField id="so-fb" label="Facebook link" {...form.register('facebook')} error={e.facebook?.message} />
        <TextField id="so-yt" label="YouTube link" {...form.register('youtube')} error={e.youtube?.message} />
        <TextField id="so-wa" label="WhatsApp number" placeholder="+919847012345" {...form.register('whatsapp')} error={e.whatsapp?.message} />
        {problem && <div className="sm:col-span-2"><FormAlert>{problem}</FormAlert></div>}
        <div className="sm:col-span-2"><button type="submit" className={primary}>Save social links</button></div>
      </form>
    </Box>
  );
}
