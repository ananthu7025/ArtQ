// Delivery areas (tasks 4.4, 4.4a): where the store delivers, in one place.
//   1. "Every other pincode": the default policy (deliver? COD? usual days, air-only areas), edited in a dialog.
//   2. Coverage: how many known pincodes are delivered, prepaid only, blocked, without a rate, air-only; a warning for
//      rules on pincodes the postal directory does not know (checkout cannot charge them).
//   3. Every known pincode with what checkout does there and why; add, edit or remove a pincode's own rule, or import
//      rules from a CSV (checked first; every row is saved or none).
import {
  COVERAGE_FILTERS, PINCODE_CSV_HEADER, PINCODE_CSV_MAX_ROWS,
  type CoverageRow, type CoverageSummary, type PincodeImportResult, type PincodeRuleView, type ShippingAdminView,
} from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { ApiError, type Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { btn, ConfirmDialog, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, TextField } from '../../components/form';
import { DEFAULT_POLICY_FIELDS, ruleForm, ruleToForm, settingsForm, settingsToForm, type RuleForm, type SettingsForm } from './forms';
import { card, Check, outline, primary, quiet } from './parts';
import { SHIPPING_KEY, useShipping } from './ShippingPage';

type Filter = (typeof COVERAGE_FILTERS)[number];
const FILTER_LABEL: Record<Filter, string> = {
  delivered: 'Delivered', no_cod: 'Delivered, prepaid only', blocked: 'Not delivered', no_rate: 'No shipping rate', air_only: 'Air-only areas',
  own_rule: 'With their own rule', own_days: 'Own delivery days', unknown: 'Not in the postal directory',
};
const COVERAGE_KEYS = [['coverage'], ['coverage-summary']] as const;
const days = (d: { min: number; max: number }) => `${d.min}–${d.max} days`;
const count = (n: number) => n.toLocaleString('en-IN');

export function AreasTab() {
  const qc = useQueryClient();
  const shipping = useShipping();
  const refresh = () => Promise.all(COVERAGE_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey })));
  return (
    <div className="space-y-6">
      {shipping.data ? <DefaultPolicy data={shipping.data} onSaved={refresh} /> : <p role="status" className="text-ink-700">Loading…</p>}
      <Summary />
      <Pincodes states={shipping.data?.states ?? []} refresh={refresh} />
    </div>
  );
}

// ── 1. The default policy ──
function DefaultPolicy({ data, onSaved }: { data: ShippingAdminView; onSaved: () => unknown }) {
  const [editing, setEditing] = useState(false);
  const s = data.settings;
  const policy = !s.defaultServiceable ? 'Not delivered (only pincodes with their own rule)' : s.defaultCod ? 'Delivered, with cash on delivery' : 'Delivered, prepaid only';
  return (
    <section aria-labelledby="default-h" className={card}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="default-h" className="font-semibold text-ink-900">Every other pincode</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">Pincodes in the postal directory without their own rule follow this. The price always comes from the zone of the pincode’s state.</p>
        </div>
        <button type="button" className={outline} onClick={() => setEditing(true)}>Edit default</button>
      </div>
      <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
        <div><dt className="text-ink-700">Delivery</dt><dd className={`font-medium ${s.defaultServiceable ? 'text-ink-900' : 'text-danger-700'}`}>{policy}</dd></div>
        <div><dt className="text-ink-700">Usual delivery</dt><dd className="font-medium text-ink-900">{days(s.estimatedDays)}</dd></div>
        <div><dt className="text-ink-700">Air-only areas (no resin)</dt><dd className="font-medium text-ink-900">{s.airOnlyPincodePrefixes.length ? s.airOnlyPincodePrefixes.map((p) => `${p}…`).join(', ') : 'None'}</dd></div>
      </dl>
      {editing && <DefaultDialog settings={s} onClose={(saved) => { setEditing(false); if (saved) void onSaved(); }} />}
    </section>
  );
}

function DefaultDialog({ settings, onClose }: { settings: ShippingAdminView['settings']; onClose: (saved: boolean) => void }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  // The whole SHIPPING setting goes back (one shared schema); only the default-policy fields are shown here.
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<SettingsForm, unknown, ReturnType<typeof settingsForm.parse>>({ resolver: zodResolver(settingsForm), defaultValues: settingsToForm(settings) });
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try { qc.setQueryData(SHIPPING_KEY, await api.request<ShippingAdminView>('PUT', '/admin/shipping/settings', { body })); toast.success('Default delivery saved'); onClose(true); }
    catch (e) {
      // One text box holds the whole prefix list: an error on one prefix goes on the box.
      if (e instanceof ApiError && Array.isArray(e.details)) for (const d of e.details as { path?: string }[]) if (d.path?.startsWith('airOnlyPincodePrefixes')) d.path = 'airOnlyPincodePrefixes';
      if (!applyServerErrors(e, setError, DEFAULT_POLICY_FIELDS)) setProblem(errorMessage(e));
    }
  });
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) onClose(false); }} title="Default delivery" description="For every pincode without its own rule.">
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-4">
        <Check id="d-serviceable" label="Deliver to every pincode unless it is blocked" help="Off: only pincodes with their own rule saying we deliver." {...register('defaultServiceable')} />
        <Check id="d-cod" label="Cash on delivery wherever we deliver" help="Pincodes can still turn it off one by one." {...register('defaultCod')} />
        <div className="grid grid-cols-2 gap-3">
          <TextField id="d-days-min" label="Usual delivery: from (days)" inputMode="numeric" {...register('estimatedDays.min')} error={errors.estimatedDays?.min?.message} />
          <TextField id="d-days-max" label="Usual delivery: to (days)" inputMode="numeric" {...register('estimatedDays.max')} error={errors.estimatedDays?.max?.message} />
        </div>
        <TextField id="d-air" label="Areas only reachable by air (pincode starts)" hint="Resin and other surface-only items cannot ship here. Separate with commas, e.g. 744, 68255." {...register('airOnlyPincodePrefixes')} error={errors.airOnlyPincodePrefixes?.message} />
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className={quiet} onClick={() => onClose(false)}>Cancel</button>
          <button type="submit" disabled={isSubmitting} className={primary}>{isSubmitting ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </FormDialog>
  );
}

// ── 2. Coverage summary ──
function Summary() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'pincode', filterKeys: ['q', 'state', 'filter'] });
  const q = useQuery({ queryKey: ['coverage-summary'], queryFn: () => api.request<CoverageSummary>('GET', '/admin/shipping/coverage/summary') });
  if (q.isPending) return null;
  if (q.isError) return <FormAlert>Couldn’t load the coverage. <button type="button" className="underline" onClick={() => void q.refetch()}>Retry</button></FormAlert>;
  const s = q.data;
  // A count stands for all such pincodes: any search or state filter is cleared first.
  const show = (f: Filter) => { params.clearFilters(); params.setFilter('filter', f); };
  const stat = (label: string, n: number, f: Filter | null, tone = 'text-ink-900') => (
    <div className="min-w-0">
      <dt className="text-sm text-ink-700">{label}</dt>
      <dd>{f && n > 0
        ? <button type="button" className={`text-xl font-semibold tabular-nums underline-offset-2 hover:underline ${tone}`} aria-label={`${label}: ${count(n)}. Show them`} onClick={() => show(f)}>{count(n)}</button>
        : <span className={`text-xl font-semibold tabular-nums ${n > 0 ? tone : 'text-ink-900'}`}>{count(n)}</span>}</dd>
    </div>
  );
  return (
    <section aria-labelledby="coverage-h" className="space-y-3">
      <h2 id="coverage-h" className="font-semibold text-ink-900">Coverage</h2>
      {s.known === 0 && <FormAlert>The postal directory is empty, so checkout can’t place any pincode. Load the India Post directory with the seed step (<code className="font-mono">db:seed --postal-codes</code>).</FormAlert>}
      {s.rulesOutsideDirectory > 0 && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#f2c94c] bg-[#fff8e1] px-4 py-3 text-sm text-ink-900">
          <span>{count(s.rulesOutsideDirectory)} {s.rulesOutsideDirectory === 1 ? 'rule is' : 'rules are'} for pincodes missing from the postal directory. Checkout can’t find their state, so it can’t charge shipping there.</span>
          <button type="button" className={`${btn} border border-ink-900`} onClick={() => show('unknown')}>Show them</button>
        </div>
      )}
      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-surface-200 bg-white p-5 sm:grid-cols-3 lg:grid-cols-6">
        {stat('Known pincodes', s.known, null)}
        {stat('Delivered', s.delivered, 'delivered', 'text-success-700')}
        {stat('Prepaid only', s.delivered - s.deliveredCod, 'no_cod')}
        {stat('Not delivered', s.notDelivered, 'blocked', 'text-danger-700')}
        {stat('No shipping rate', s.noRate, 'no_rate', 'text-danger-700')}
        {stat('Air-only', s.airOnly, 'air_only')}
      </dl>
    </section>
  );
}

// ── 3. Every pincode ──
const STATUS: Record<CoverageRow['status'], { label: string; tone: string; why: string }> = {
  DELIVERED: { label: 'Delivered', tone: 'bg-[#dcfce7] text-success-700', why: '' },
  NOT_DELIVERED: { label: 'Not delivered', tone: 'bg-[#fee2e2] text-danger-700', why: '' },
  NO_RATE: { label: 'No shipping rate', tone: 'bg-[#fee2e2] text-danger-700', why: 'Its state has no zone, or the zone is off.' },
  UNKNOWN: { label: 'Not in postal directory', tone: 'bg-[#fff8e1] text-ink-900', why: 'Checkout can’t find its state, so it can’t charge shipping.' },
};

function Pincodes({ states, refresh }: { states: ShippingAdminView['states']; refresh: () => Promise<unknown> }) {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'pincode', filterKeys: ['q', 'state', 'filter'] });
  const [editing, setEditing] = useState<{ rule: PincodeRuleView | null; pincode: string | null } | null>(null);
  const [removing, setRemoving] = useState<PincodeRuleView | null>(null);
  const [importing, setImporting] = useState(false);
  const query = useQuery({
    queryKey: ['coverage', params.page, params.filters],
    queryFn: () => api.request<Page<CoverageRow>>('GET', '/admin/shipping/coverage', { query: { page: params.page, limit: 50, ...params.filters } }),
    placeholderData: (prev) => prev,
  });
  const columns: ColumnDef<CoverageRow, unknown>[] = [
    { id: 'pincode', header: 'Pincode', cell: ({ row: { original: r } }) => (
      <div>
        <div className="font-mono font-semibold text-ink-900">{r.pincode}</div>
        <div className="text-sm text-ink-700">{r.place ? `${r.place.office}${r.place.offices > 1 ? ` +${r.place.offices - 1}` : ''} · ${r.place.district}, ${r.place.state}` : 'Not in the postal directory'}</div>
      </div>
    ) },
    { id: 'zone', header: 'Zone', cell: ({ row: { original: r } }) => r.zone?.name ?? <span className="text-ink-700">None</span> },
    { id: 'delivery', header: 'Delivery', cell: ({ row: { original: r } }) => {
      const st = STATUS[r.status];
      return (
        <div className="space-y-1">
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${st.tone}`}>{st.label}</span>
          <div className="text-sm text-ink-700">{r.status === 'DELIVERED' ? (r.cod ? 'Cash on delivery' : 'Prepaid only') : st.why}{r.airOnly && <span className="block">Air-only: no resin</span>}</div>
        </div>
      );
    } },
    { id: 'days', header: 'Delivery days', cell: ({ row: { original: r } }) => (r.status === 'DELIVERED' ? days(r.days) : '') },
    { id: 'rule', header: 'Rule', cell: ({ row: { original: r } }) => (r.rule ? <div><div className="font-medium text-ink-900">Own rule</div>{r.rule.note && <div className="text-sm text-ink-700">{r.rule.note}</div>}</div> : <span className="text-ink-700">Default</span>) },
    { id: 'actions', header: () => <span className="sr-only">Actions</span>, cell: ({ row: { original: r } }) => (r.rule ? (
      <div className="flex gap-2">
        <button type="button" className={outline} aria-label={`Edit the rule for ${r.pincode}`} onClick={() => setEditing({ rule: r.rule, pincode: r.pincode })}>Edit</button>
        <button type="button" className={`${btn} text-danger-700 hover:bg-[#fee2e2]`} aria-label={`Remove the rule for ${r.pincode}`} onClick={() => setRemoving(r.rule)}>Remove</button>
      </div>
    ) : <button type="button" className={outline} aria-label={`Add a rule for ${r.pincode}`} onClick={() => setEditing({ rule: null, pincode: r.pincode })}>Add rule</button>) },
  ];
  const remove = async (r: PincodeRuleView) => {
    try { await api.request('DELETE', `/admin/shipping/pincodes/${r.pincode}`); toast.success(`${r.pincode} follows the default again`); await refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
    setRemoving(null);
  };
  const search = (v: string) => params.setFilter('q', v.trim() || null);
  return (
    <section aria-labelledby="pincodes-h" className="space-y-4">
      <h2 id="pincodes-h" className="font-semibold text-ink-900">Pincodes</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="text-sm text-ink-900">
          <label htmlFor="cov-q">Pincode or place</label>
          <input id="cov-q" type="search" className="mt-1 block h-11 w-56 rounded-md border border-border-input px-3" defaultValue={params.filters.q ?? ''} key={params.filters.q ?? ''}
            onBlur={(e) => search(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search((e.target as HTMLInputElement).value); }} />
        </div>
        <div className="text-sm text-ink-900">
          <label htmlFor="cov-state">State</label>
          <select id="cov-state" className="mt-1 block h-11 w-52 rounded-md border border-border-input bg-white px-3" value={params.filters.state ?? ''} onChange={(e) => params.setFilter('state', e.target.value || null)}>
            <option value="">All states</option>
            {states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="text-sm text-ink-900">
          <label htmlFor="cov-filter">Show</label>
          <select id="cov-filter" className="mt-1 block h-11 w-60 rounded-md border border-border-input bg-white px-3" value={params.filters.filter ?? ''} onChange={(e) => params.setFilter('filter', e.target.value || null)}>
            <option value="">All pincodes</option>
            {COVERAGE_FILTERS.map((f) => <option key={f} value={f}>{FILTER_LABEL[f]}</option>)}
          </select>
        </div>
        <div className="ml-auto flex gap-2">
          <button type="button" className={outline} onClick={() => setImporting(true)}>Import CSV</button>
          <button type="button" className={primary} onClick={() => setEditing({ rule: null, pincode: null })}>Add rule</button>
        </div>
      </div>
      <DataTable caption="Pincodes" columns={columns} query={query} params={params} getRowId={(r) => r.pincode}
        emptyMessage={params.hasFilters ? 'No pincode matches. Try another search or filter.' : 'No pincodes yet. Load the postal directory, or add a rule.'} />
      {editing && <RuleDialog key={editing.pincode ?? 'new'} rule={editing.rule} pincode={editing.pincode} onClose={(saved) => { setEditing(null); if (saved) void refresh(); }} />}
      {removing && <ConfirmDialog open onOpenChange={(o) => { if (!o) setRemoving(null); }} title={`Remove the rule for ${removing.pincode}?`} confirmLabel="Remove" danger
        description="The pincode then follows the default delivery." onConfirm={() => void remove(removing)} />}
      <ImportDialog open={importing} onClose={(saved) => { setImporting(false); if (saved) void refresh(); }} />
    </section>
  );
}

function RuleDialog({ rule, pincode, onClose }: { rule: PincodeRuleView | null; pincode: string | null; onClose: (saved: boolean) => void }) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const fixed = rule !== null || pincode !== null;
  const { register, handleSubmit, setError, getValues, formState: { errors, isSubmitting } } = useForm<RuleForm, unknown, ReturnType<typeof ruleForm.parse>>({
    resolver: zodResolver(ruleForm), defaultValues: rule ? ruleToForm(rule) : { ...ruleToForm(null), pincode: pincode ?? '' },
  });
  const save = handleSubmit(async (body) => {
    setProblem(null);
    const pin = getValues('pincode').trim();
    try {
      const saved = await api.request<PincodeRuleView>('PUT', `/admin/shipping/pincodes/${pin}`, { body });
      if (!saved.place && saved.isServiceable) toast.warning(`${pin} saved, but it isn’t in the postal directory, so checkout can’t charge shipping there.`);
      else toast.success(`${pin} saved`);
      onClose(true);
    } catch (err) { if (!applyServerErrors(err, setError, ['isServiceable', 'codAvailable', 'eddMinDays', 'eddMaxDays', 'note'])) setProblem(errorMessage(err)); }
  });
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) onClose(false); }} title={fixed ? `Pincode ${rule?.pincode ?? pincode}` : 'Add a pincode rule'} description="Overrides the default delivery for this pincode. The price still comes from its state’s zone.">
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-4">
        <TextField id="rule-pincode" label="Pincode" inputMode="numeric" maxLength={6} readOnly={fixed} {...register('pincode')} error={errors.pincode?.message} />
        <label className="flex items-center gap-3 text-sm text-ink-900"><input type="checkbox" className="h-5 w-5 accent-brand-700" {...register('isServiceable')} />We deliver here</label>
        <div>
          <label className="flex items-center gap-3 text-sm text-ink-900"><input id="rule-cod" type="checkbox" className="h-5 w-5 accent-brand-700" aria-invalid={errors.codAvailable ? true : undefined} aria-describedby={errors.codAvailable ? 'rule-cod-error' : undefined} {...register('codAvailable')} />Cash on delivery available</label>
          {errors.codAvailable && <p id="rule-cod-error" className="mt-1 text-sm text-danger-700">{errors.codAvailable.message}</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextField id="rule-min" label="Delivery from (days)" inputMode="numeric" hint="Empty = default" {...register('eddMinDays')} error={errors.eddMinDays?.message} />
          <TextField id="rule-max" label="Delivery to (days)" inputMode="numeric" {...register('eddMaxDays')} error={errors.eddMaxDays?.message} />
        </div>
        <TextField id="rule-note" label="Note (staff only, optional)" {...register('note')} error={errors.note?.message} />
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className={quiet} onClick={() => onClose(false)}>Cancel</button>
          <button type="submit" disabled={isSubmitting} className={primary}>{isSubmitting ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </FormDialog>
  );
}

function ImportDialog({ open, onClose }: { open: boolean; onClose: (saved: boolean) => void }) {
  const { api } = useAuth();
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [check, setCheck] = useState<PincodeImportResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = () => { setCsv(null); setCheck(null); setProblem(null); };
  const send = async (dryRun: boolean, text = csv!.text) => {
    setBusy(true); setProblem(null);
    try {
      const r = await api.request<PincodeImportResult>('POST', '/admin/shipping/pincodes/import', { body: { csv: text, dryRun } });
      if (!dryRun && r.saved) { toast.success(`${r.created + r.updated} pincode${r.created + r.updated === 1 ? '' : 's'} saved`); reset(); onClose(true); }
      else setCheck(r);
    } catch (e) { setProblem(errorMessage(e)); }
    setBusy(false);
  };
  const choose = async (file: File | undefined) => {
    reset();
    if (!file) return;
    if (file.size > 2_000_000) { setProblem('The file is larger than 2 MB. Split it into smaller files.'); return; }
    const text = await file.text();
    setCsv({ name: file.name, text });
    await send(true, text);
  };
  return (
    <FormDialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(false); } }} title="Import pincode rules"
      description={<>A CSV with the columns <code className="font-mono">{PINCODE_CSV_HEADER.join(',')}</code>. Use yes/no for deliverable and cod; leave the days empty for the default. Up to {PINCODE_CSV_MAX_ROWS.toLocaleString('en-IN')} rows. The file is checked first; nothing is saved unless every row is valid.</>}>
      <div className="space-y-4">
        <div>
          <label htmlFor="import-file" className="block text-sm font-medium text-ink-900">CSV file</label>
          <input id="import-file" type="file" accept=".csv,text/csv" className="mt-1 block w-full text-sm" onChange={(e) => void choose(e.target.files?.[0])} />
        </div>
        {busy && <p role="status" className="text-sm text-ink-700">Checking…</p>}
        {problem && <FormAlert>{problem}</FormAlert>}
        {check && !busy && (
          <div role="status" className="space-y-2 text-sm">
            {check.errors.length ? (
              <>
                <p className="font-medium text-danger-700">{csv?.name}: {check.errors.length === 100 ? '100 or more' : check.errors.length} problem{check.errors.length === 1 ? '' : 's'}. Fix the file and choose it again.</p>
                <ul className="max-h-56 overflow-y-auto rounded-md border border-surface-200 p-2">
                  {check.errors.map((e) => <li key={e.line}><span className="font-medium">Line {e.line}:</span> {e.message}</li>)}
                </ul>
              </>
            ) : (
              <p className="text-ink-900">{csv?.name}: {check.rows} rows. {check.created} new, {check.updated} changed, {check.unchanged} unchanged.</p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className={quiet} onClick={() => { reset(); onClose(false); }}>Cancel</button>
          <button type="button" className={primary} disabled={!check || check.errors.length > 0 || busy || check.created + check.updated === 0} onClick={() => void send(false)}>
            {check && !check.errors.length ? `Save ${check.created + check.updated} pincode${check.created + check.updated === 1 ? '' : 's'}` : 'Save'}
          </button>
        </div>
      </div>
    </FormDialog>
  );
}
