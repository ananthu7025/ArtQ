// Shipping Rates (product.md §7 "Shipping Rates", §8.2, api.md §4.8) [shipping:write]: zones (weight slabs + extra ₹/kg),
// which zone each state ships at, the shipping settings (free-shipping threshold, heavy cap, packaging, default delivery
// policy, air-only areas), delivery areas per pincode (AreasTab) and a preview calculator. Rates are entered in rupees
// and weights in grams; every form validates with the shared schema after converting (forms.ts).
import { formatINR, type ShippingAdminView, type ShippingPreview, type ZoneView } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { btn, ConfirmDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, SelectField, TextField } from '../../components/form';
import { PageHeader } from '../simple';
import { AreasTab } from './AreasTab';
import { EMPTY_PREVIEW, previewForm, SETTINGS_FIELDS, settingsForm, settingsToForm, zoneFields, zoneForm, zoneToForm, type PreviewForm, type SettingsForm, type ZoneForm } from './forms';

const TABS = [{ key: 'rates', label: 'Rates & zones' }, { key: 'areas', label: 'Delivery areas' }, { key: 'settings', label: 'Settings' }, { key: 'preview', label: 'Preview' }] as const;
type Tab = (typeof TABS)[number]['key'];
const card = 'rounded-lg border border-surface-200 bg-white p-5';
const primary = `${btn} bg-brand-700 text-white disabled:opacity-80`;
const quiet = `${btn} text-ink-900 hover:bg-surface-100`;
export const SHIPPING_KEY = ['shipping'] as const;

export function useShipping() {
  const { api } = useAuth();
  return useQuery({ queryKey: SHIPPING_KEY, queryFn: () => api.request<ShippingAdminView>('GET', '/admin/shipping') });
}

export function ShippingPage() {
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.find((t) => t.key === sp.get('tab'))?.key ?? 'rates') as Tab;
  const choose = (k: Tab) => setSp(k === 'rates' ? {} : { tab: k });
  return (
    <>
      <PageHeader title="Shipping Rates" />
      <div role="tablist" aria-label="Shipping" className="mb-5 flex flex-wrap gap-1 border-b border-surface-200"
        onKeyDown={(e) => {
          const i = TABS.findIndex((t) => t.key === tab);
          const next = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i + TABS.length - 1) % TABS.length] : null;
          if (next) { e.preventDefault(); choose(next.key); document.getElementById(`tab-${next.key}`)?.focus(); }
        }}>
        {TABS.map((t) => (
          <button key={t.key} id={`tab-${t.key}`} type="button" role="tab" aria-selected={tab === t.key} aria-controls={`panel-${t.key}`} tabIndex={tab === t.key ? 0 : -1} onClick={() => choose(t.key)}
            className="-mb-px h-11 border-b-2 border-transparent px-4 text-sm font-medium text-ink-700 aria-selected:border-brand-700 aria-selected:text-brand-700">{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'rates' && <RatesTab />}
        {tab === 'areas' && <AreasTab />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'preview' && <PreviewTab />}
      </div>
    </>
  );
}

function Loaded({ children }: { children: (data: ShippingAdminView) => React.ReactNode }) {
  const q = useShipping();
  if (q.isPending) return <p role="status" className="text-ink-700">Loading…</p>;
  if (q.isError) return <FormAlert>Couldn’t load. <button type="button" className="underline" onClick={() => void q.refetch()}>Retry</button></FormAlert>;
  return <>{children(q.data)}</>;
}

// ── Rates & zones ──
function RatesTab() {
  const [adding, setAdding] = useState(false);
  return (
    <Loaded>{(data) => (
      <div className="space-y-5">
        <p className="max-w-3xl text-sm text-ink-700">Each order is charged by its chargeable weight (actual or volumetric, plus packaging): the first slab it fits in, then the zone’s extra rate for each kg beyond the last slab. Orders over the free-shipping threshold ship free up to the heavy cap (Settings).</p>
        {data.zones.map((z) => <ZoneCard key={`${z.id}-${z.slabs.length}-${z.name}`} zone={z} />)}
        {adding ? <ZoneCard zone={null} onDone={() => setAdding(false)} /> : <button type="button" className={`${btn} border border-border-input`} onClick={() => setAdding(true)}><Plus size={16} aria-hidden className="mr-1" />Add zone</button>}
        <StateMapping data={data} />
      </div>
    )}</Loaded>
  );
}

function ZoneCard({ zone, onDone }: { zone: ZoneView | null; onDone?: () => void }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { register, control, handleSubmit, setError, formState: { errors, isSubmitting, isDirty } } = useForm<ZoneForm, unknown, ReturnType<typeof zoneForm.parse>>({ resolver: zodResolver(zoneForm), defaultValues: zoneToForm(zone) });
  const slabs = useFieldArray({ control, name: 'slabs' });
  const idp = `zone-${zone?.id ?? 'new'}`;
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try {
      const view = await api.request<ShippingAdminView>(zone ? 'PUT' : 'POST', zone ? `/admin/shipping/zones/${zone.id}` : '/admin/shipping/zones', { body });
      qc.setQueryData(SHIPPING_KEY, view);
      toast.success(`${body.name} saved`);
      onDone?.();
    } catch (e) { if (!applyServerErrors(e, setError, zoneFields(slabs.fields.length) as never)) setProblem(errorMessage(e)); }
  });
  const remove = async () => {
    try { qc.setQueryData(SHIPPING_KEY, await api.request<ShippingAdminView>('DELETE', `/admin/shipping/zones/${zone!.id}`)); toast.success(`${zone!.name} deleted`); }
    catch (e) { setProblem(errorMessage(e)); }
    setDeleting(false);
  };
  return (
    <section aria-labelledby={`${idp}-title`} className={card}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${idp}-title`} className="font-semibold text-ink-900">{zone ? zone.name : 'New zone'}{zone && !zone.isActive && <span className="ml-2 text-sm font-normal text-ink-700">(off)</span>}</h2>
        {zone && <p className="text-sm text-ink-700">{zone.states.length ? zone.states.map((s) => s.name).join(', ') : 'No states yet'}</p>}
      </div>
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField id={`${idp}-name`} label="Zone name" {...register('name')} error={errors.name?.message} />
          <TextField id={`${idp}-extra`} label="Extra per kg beyond the last slab (₹)" inputMode="decimal" {...register('extraPerKg')} error={errors.extraPerKg?.message} />
          <label className="flex items-center gap-3 self-end pb-3 text-sm text-ink-900"><input type="checkbox" className="h-5 w-5 accent-brand-700" {...register('isActive')} />On (states in an off zone get no rate)</label>
        </div>
        <fieldset>
          <legend className="text-sm font-medium text-ink-900">Weight slabs (lightest first)</legend>
          {errors.slabs?.message && <p className="mt-1 text-sm text-danger-700">{errors.slabs.message}</p>}
          <ol className="mt-2 space-y-2">
            {slabs.fields.map((f, i) => (
              <li key={f.id} className="flex flex-wrap items-start gap-3">
                <TextField id={`${idp}-slab-${i}-w`} label={`Slab ${i + 1}: up to (grams)`} inputMode="numeric" className="w-48" {...register(`slabs.${i}.maxWeightG`)} error={errors.slabs?.[i]?.maxWeightG?.message} />
                <TextField id={`${idp}-slab-${i}-r`} label={`Slab ${i + 1}: rate (₹)`} inputMode="decimal" className="w-40" {...register(`slabs.${i}.rate`)} error={errors.slabs?.[i]?.rate?.message} />
                <button type="button" onClick={() => slabs.remove(i)} disabled={slabs.fields.length === 1} aria-label={`Remove slab ${i + 1}`} className="mt-7 flex h-11 w-11 items-center justify-center rounded-md text-ink-700 hover:bg-surface-100 disabled:opacity-40"><Trash2 size={16} aria-hidden /></button>
              </li>
            ))}
          </ol>
          <button type="button" className={`${quiet} mt-2`} onClick={() => slabs.append({ maxWeightG: '', rate: '' })}><Plus size={16} aria-hidden className="mr-1" />Add slab</button>
        </fieldset>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={isSubmitting} className={primary}>{isSubmitting ? 'Saving…' : zone ? 'Save zone' : 'Create zone'}</button>
          {!zone && <button type="button" className={quiet} onClick={onDone}>Cancel</button>}
          {zone && isDirty && <span className="self-center text-sm text-ink-700">Unsaved changes</span>}
          {zone && <button type="button" className={`${btn} ml-auto text-danger-700 hover:bg-[#fee2e2]`} onClick={() => setDeleting(true)}>Delete zone</button>}
        </div>
      </form>
      {zone && (
        <ConfirmDialog open={deleting} onOpenChange={setDeleting} title={`Delete ${zone.name}?`} danger confirmLabel="Delete" onConfirm={() => void remove()}
          description={zone.states.length ? 'Its states must move to another zone first.' : zone.usedByOrders ? 'Orders were charged with this zone, so it cannot be deleted. Turn it off instead.' : 'The zone and its slabs are removed.'} />
      )}
    </section>
  );
}

function StateMapping({ data }: { data: ShippingAdminView }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<number, number | null>>({});
  const [busy, setBusy] = useState(false);
  const changed = Object.entries(draft).filter(([id, z]) => data.states.find((s) => s.id === Number(id))?.zoneId !== z);
  const save = async () => {
    setBusy(true);
    try {
      qc.setQueryData(SHIPPING_KEY, await api.request<ShippingAdminView>('PUT', '/admin/shipping/state-zones', { body: { assignments: changed.map(([id, z]) => ({ stateId: Number(id), zoneId: z })) } }));
      setDraft({});
      toast.success(`${changed.length} state${changed.length === 1 ? '' : 's'} moved`);
    } catch (e) { toast.error(errorMessage(e)); }
    setBusy(false);
  };
  const unmapped = data.states.filter((s) => (draft[s.id] !== undefined ? draft[s.id] : s.zoneId) === null).length;
  return (
    <section aria-labelledby="state-map" className={card}>
      <h2 id="state-map" className="font-semibold text-ink-900">Which zone each state ships at</h2>
      <p className="mt-1 text-sm text-ink-700">A state with no zone gets no shipping rate, so its pincodes cannot check out.{unmapped > 0 && <strong className="text-warning-ink"> {unmapped} without a zone.</strong>}</p>
      <div className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {data.states.map((s) => (
          <label key={s.id} className="flex items-center justify-between gap-3 text-sm text-ink-900">
            <span>{s.name}</span>
            <select value={String(draft[s.id] !== undefined ? draft[s.id] : s.zoneId ?? '')} onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.value === '' ? null : Number(e.target.value) }))}
              className="h-10 w-44 rounded-md border border-border-input bg-white px-2">
              <option value="">No zone</option>
              {data.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="mt-4 flex gap-3">
        <button type="button" className={primary} disabled={changed.length === 0 || busy} onClick={() => void save()}>{busy ? 'Saving…' : `Save ${changed.length || ''} change${changed.length === 1 ? '' : 's'}`.replace('  ', ' ')}</button>
        {changed.length > 0 && <button type="button" className={quiet} onClick={() => setDraft({})}>Undo</button>}
      </div>
    </section>
  );
}

// ── Settings ──
function SettingsTab() {
  return <Loaded>{(data) => <SettingsFormView key={JSON.stringify(data.settings)} settings={data.settings} />}</Loaded>;
}

function Check({ id, label, help, ...input }: { id: string; label: string; help?: string } & React.InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <div className="flex items-start gap-3 text-sm text-ink-900">
      <input id={id} type="checkbox" className="mt-0.5 h-5 w-5 accent-brand-700" aria-describedby={help ? `${id}-help` : undefined} {...input} />
      <div><label htmlFor={id} className="font-medium">{label}</label>{help && <p id={`${id}-help`} className="text-ink-700">{help}</p>}</div>
    </div>
  );
}

function SettingsFormView({ settings }: { settings: ShippingAdminView['settings'] }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<SettingsForm, unknown, ReturnType<typeof settingsForm.parse>>({ resolver: zodResolver(settingsForm), defaultValues: settingsToForm(settings) });
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try { qc.setQueryData(SHIPPING_KEY, await api.request<ShippingAdminView>('PUT', '/admin/shipping/settings', { body })); toast.success('Shipping settings saved'); }
    catch (e) {
      // One text box holds the whole prefix list: an error on one prefix goes on the box.
      if (e instanceof ApiError && Array.isArray(e.details)) for (const d of e.details as { path?: string }[]) if (d.path?.startsWith('airOnlyPincodePrefixes')) d.path = 'airOnlyPincodePrefixes';
      if (!applyServerErrors(e, setError, SETTINGS_FIELDS)) setProblem(errorMessage(e));
    }
  });
  return (
    <form noValidate onSubmit={(e) => { void save(e); }} className="max-w-3xl space-y-5">
      <section aria-labelledby="s-free" className={card}>
        <h2 id="s-free" className="mb-4 font-semibold text-ink-900">Free shipping</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id="s-threshold" label="Free shipping from (₹)" inputMode="decimal" hint="Order value after any coupon." {...register('freeThreshold')} error={errors.freeThreshold?.message} />
          <TextField id="s-cap" label="Free up to (grams)" inputMode="numeric" hint="Heavier free orders pay the zone’s extra rate per kg above this." {...register('heavyCapG')} error={errors.heavyCapG?.message} />
        </div>
        <div className="mt-4"><Check id="s-cap-on" label="Apply the weight limit to free shipping" {...register('heavyCapEnabled')} /></div>
      </section>
      <section aria-labelledby="s-weight" className={card}>
        <h2 id="s-weight" className="mb-4 font-semibold text-ink-900">Weight</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id="s-pack" label="Packaging added to every order (grams)" inputMode="numeric" {...register('packagingWeightG')} error={errors.packagingWeightG?.message} />
          <TextField id="s-div" label="Volumetric divisor" inputMode="numeric" hint="L × W × H (cm) ÷ this = kg. Couriers usually use 5,000." {...register('volumetricDivisor')} error={errors.volumetricDivisor?.message} />
        </div>
      </section>
      <section aria-labelledby="s-areas" className={card}>
        <h2 id="s-areas" className="mb-4 font-semibold text-ink-900">Where we deliver by default</h2>
        <div className="space-y-3">
          <Check id="s-serviceable" label="Deliver to every pincode unless it is blocked" help="Off: only pincodes listed under Delivery areas as deliverable." {...register('defaultServiceable')} />
          <Check id="s-cod" label="Cash on delivery wherever we deliver" help="Pincodes can still turn it off one by one." {...register('defaultCod')} />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextField id="s-days-min" label="Usual delivery: from (days)" inputMode="numeric" {...register('estimatedDays.min')} error={errors.estimatedDays?.min?.message} />
          <TextField id="s-days-max" label="Usual delivery: to (days)" inputMode="numeric" {...register('estimatedDays.max')} error={errors.estimatedDays?.max?.message} />
        </div>
        <div className="mt-4">
          <TextField id="s-air" label="Areas only reachable by air (pincode starts)" hint="Resin and other surface-only items cannot ship here. Separate with commas, e.g. 744, 68255." {...register('airOnlyPincodePrefixes')} error={errors.airOnlyPincodePrefixes?.message} />
        </div>
      </section>
      {problem && <FormAlert>{problem}</FormAlert>}
      <button type="submit" disabled={isSubmitting} className={primary}>{isSubmitting ? 'Saving…' : 'Save settings'}</button>
    </form>
  );
}

// ── Preview ──
const ERROR_TEXT: Record<Extract<ShippingPreview['quote'], { ok: false }>['error'], string> = {
  PINCODE_NOT_SERVICEABLE: 'We do not deliver to this pincode.',
  SHIPPING_RESTRICTED: 'This item travels by road only and cannot reach this pincode.',
  DIMENSIONS_REQUIRED: 'Bulky items need their dimensions.',
  NO_RATE: 'No slab covers this weight.',
  NO_ZONE: 'This state has no active shipping zone, so there is no rate.',
  UNKNOWN_PINCODE: 'This pincode is not in the postal directory (probably mistyped).',
};

function PreviewTab() {
  const { api } = useAuth();
  const [result, setResult] = useState<ShippingPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<PreviewForm, unknown, ReturnType<typeof previewForm.parse>>({ resolver: zodResolver(previewForm), defaultValues: EMPTY_PREVIEW });
  const run = handleSubmit(async (body) => {
    setProblem(null);
    try { setResult(await api.request<ShippingPreview>('POST', '/admin/shipping/preview', { body })); }
    catch (e) { setResult(null); if (!applyServerErrors(e, setError, ['pincode', 'weightG', 'quantity', 'subtotal', 'couponDiscount', 'length', 'width', 'height'])) setProblem(errorMessage(e)); }
  });
  const q = result?.quote;
  return (
    <div className="grid max-w-5xl gap-5 lg:grid-cols-[1fr_340px]">
      <form noValidate onSubmit={(e) => { void run(e); }} className={`${card} grid gap-4 sm:grid-cols-2`}>
        <TextField id="p-pincode" label="Pincode" inputMode="numeric" maxLength={6} {...register('pincode')} error={errors.pincode?.message} />
        <TextField id="p-weight" label="Packed weight per item (grams)" inputMode="numeric" {...register('weightG')} error={errors.weightG?.message} />
        <TextField id="p-qty" label="Quantity" inputMode="numeric" {...register('quantity')} error={errors.quantity?.message} />
        <SelectField id="p-class" label="Item type" {...register('shippingClass')}>
          <option value="STANDARD">Standard</option><option value="BULKY">Bulky (needs dimensions)</option><option value="SURFACE_ONLY">Surface only (resin)</option>
        </SelectField>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-ink-900">Box size per item (cm, optional)</legend>
          <div className="grid grid-cols-3 gap-3">
            <TextField id="p-l" label="Length" inputMode="decimal" {...register('length')} error={errors.length?.message} />
            <TextField id="p-w" label="Width" inputMode="decimal" {...register('width')} error={errors.width?.message} />
            <TextField id="p-h" label="Height" inputMode="decimal" {...register('height')} error={errors.height?.message} />
          </div>
        </fieldset>
        <TextField id="p-subtotal" label="Order value (₹)" inputMode="decimal" {...register('subtotal')} error={errors.subtotal?.message} />
        <TextField id="p-coupon" label="Coupon discount (₹, optional)" inputMode="decimal" {...register('couponDiscount')} error={errors.couponDiscount?.message} />
        <label className="flex items-center gap-3 text-sm text-ink-900 sm:col-span-2"><input type="checkbox" className="h-5 w-5 accent-brand-700" {...register('freeShippingCoupon')} />With a free-shipping coupon</label>
        {problem && <div className="sm:col-span-2"><FormAlert>{problem}</FormAlert></div>}
        <div className="sm:col-span-2"><button type="submit" disabled={isSubmitting} className={primary}>{isSubmitting ? 'Calculating…' : 'Calculate'}</button></div>
      </form>
      <section aria-labelledby="p-result" aria-live="polite" className={card}>
        <h2 id="p-result" className="font-semibold text-ink-900">Result</h2>
        {!result && <p className="mt-2 text-sm text-ink-700">Enter a pincode, weight and order value, then Calculate.</p>}
        {result && (
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-ink-700">Place</dt><dd className="text-right text-ink-900">{result.place ? `${result.place.district}, ${result.place.state}` : 'Not in the directory'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-700">Zone</dt><dd className="text-ink-900">{result.zone?.name ?? 'None'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-700">Delivery</dt><dd className="text-right text-ink-900">{result.serviceability.serviceable ? 'Yes' : 'No'}{result.serviceability.serviceable && (result.serviceability.codAvailable ? ', COD' : ', prepaid only')}{result.serviceability.fromRule ? ' (own rule)' : ' (default)'}</dd></div>
            {!result.surfaceAvailable && <p className="text-warning-ink">Air-only area: resin cannot ship here.</p>}
            {q?.ok ? (
              <>
                <div className="flex justify-between gap-3"><dt className="text-ink-700">Weight (actual / charged)</dt><dd className="text-ink-900">{q.actualWeightG.toLocaleString('en-IN')} g / {q.chargeableWeightG.toLocaleString('en-IN')} g</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-ink-700">Rate for that weight</dt><dd className="text-ink-900">{formatINR(q.rate)}</dd></div>
                <div className="flex justify-between gap-3 border-t border-surface-200 pt-2 text-base"><dt className="font-semibold text-ink-900">Customer pays</dt><dd className="font-semibold text-ink-900">{q.shipping === 0 ? 'Free' : formatINR(q.shipping)}</dd></div>
                {q.freeShippingApplied && q.heavySurcharge > 0 && <p className="text-ink-700">Free shipping, plus {formatINR(q.heavySurcharge)} for the weight above the free limit.</p>}
                {!q.freeShippingApplied && q.remainingForFree > 0 && <p className="text-ink-700">{formatINR(q.remainingForFree)} more for free shipping.</p>}
              </>
            ) : q && <p role="alert" className="text-danger-700">{ERROR_TEXT[q.error]}</p>}
          </dl>
        )}
      </section>
    </div>
  );
}
