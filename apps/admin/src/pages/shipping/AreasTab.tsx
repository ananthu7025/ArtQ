// Delivery areas (task 4.4): pincodes with their own rule (deliverable, COD, delivery days), overriding the default
// policy in Settings. Add or edit one at a time, or import a CSV (checked first; every row is saved or none).
import { PINCODE_CSV_HEADER, PINCODE_CSV_MAX_ROWS, type PincodeImportResult, type PincodeRuleView } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { btn, ConfirmDialog, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, TextField } from '../../components/form';
import { ruleForm, ruleToForm, type RuleForm } from './forms';

const primary = `${btn} bg-brand-700 text-white disabled:opacity-80`;
const quiet = `${btn} text-ink-900 hover:bg-surface-100`;
const FILTERS = [{ value: 'blocked', label: 'Not delivered' }, { value: 'no_cod', label: 'No cash on delivery' }, { value: 'custom_days', label: 'Own delivery days' }] as const;

export function AreasTab() {
  const { api } = useAuth();
  const qc = useQueryClient();
  const params = useTableParams({ sort: 'pincode', filterKeys: ['q', 'filter'] });
  const [editing, setEditing] = useState<PincodeRuleView | 'new' | null>(null);
  const [removing, setRemoving] = useState<PincodeRuleView | null>(null);
  const [importing, setImporting] = useState(false);
  const query = useQuery({
    queryKey: ['pincode-rules', params.page, params.filters],
    queryFn: () => api.request<Page<PincodeRuleView>>('GET', '/admin/shipping/pincodes', { query: { page: params.page, limit: 50, ...params.filters } }),
    placeholderData: (prev) => prev,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['pincode-rules'] });
  const columns: ColumnDef<PincodeRuleView, unknown>[] = [
    { id: 'pincode', header: 'Pincode', cell: ({ row }) => <div><div className="font-mono font-semibold text-ink-900">{row.original.pincode}</div><div className="text-sm text-ink-700">{row.original.place ? `${row.original.place.district}, ${row.original.place.state}` : 'Not in the postal directory'}</div></div> },
    { id: 'delivery', header: 'Delivery', cell: ({ row }) => (row.original.isServiceable ? (row.original.codAvailable ? 'Yes, with COD' : 'Yes, prepaid only') : <span className="font-medium text-danger-700">Not delivered</span>) },
    { id: 'days', header: 'Delivery days', cell: ({ row }) => (row.original.eddMinDays !== null ? `${row.original.eddMinDays}–${row.original.eddMaxDays} days` : <span className="text-ink-700">Default</span>) },
    { id: 'note', header: 'Note', cell: ({ row }) => row.original.note ?? '' },
    { id: 'actions', header: () => <span className="sr-only">Actions</span>, cell: ({ row }) => (
      <div className="flex gap-2">
        <button type="button" className={`${btn} border border-border-input`} aria-label={`Edit ${row.original.pincode}`} onClick={() => setEditing(row.original)}>Edit</button>
        <button type="button" className={`${btn} text-danger-700 hover:bg-[#fee2e2]`} aria-label={`Remove the rule for ${row.original.pincode}`} onClick={() => setRemoving(row.original)}>Remove</button>
      </div>
    ) },
  ];
  const remove = async (r: PincodeRuleView) => {
    try { await api.request('DELETE', `/admin/shipping/pincodes/${r.pincode}`); toast.success(`${r.pincode} follows the default again`); await refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
    setRemoving(null);
  };
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-ink-700">Pincodes listed here follow their own rule. Every other pincode follows the default in Settings. Being in the postal directory does not by itself mean we deliver there.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-ink-900">Pincode starts with
          <input inputMode="numeric" className="mt-1 block h-11 w-48 rounded-md border border-border-input px-3" defaultValue={params.filters.q ?? ''} key={params.filters.q ?? ''}
            onBlur={(e) => params.setFilter('q', e.target.value.trim() || null)} onKeyDown={(e) => { if (e.key === 'Enter') params.setFilter('q', (e.target as HTMLInputElement).value.trim() || null); }} />
        </label>
        <label className="text-sm text-ink-900">Show
          <select className="mt-1 block h-11 w-52 rounded-md border border-border-input bg-white px-3" value={params.filters.filter ?? ''} onChange={(e) => params.setFilter('filter', e.target.value || null)}>
            <option value="">All rules</option>
            {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        <div className="ml-auto flex gap-2">
          <button type="button" className={`${btn} border border-border-input`} onClick={() => setImporting(true)}>Import CSV</button>
          <button type="button" className={primary} onClick={() => setEditing('new')}>Add pincode</button>
        </div>
      </div>
      <DataTable caption="Pincode rules" columns={columns} query={query} params={params} getRowId={(r) => r.pincode} emptyMessage="No pincode has its own rule. Every pincode follows the default." />
      {editing && <RuleDialog key={editing === 'new' ? 'new' : editing.pincode} rule={editing === 'new' ? null : editing} onClose={(saved) => { setEditing(null); if (saved) void refresh(); }} />}
      {removing && <ConfirmDialog open onOpenChange={(o) => { if (!o) setRemoving(null); }} title={`Remove the rule for ${removing.pincode}?`} confirmLabel="Remove" danger
        description="The pincode then follows the default delivery policy in Settings." onConfirm={() => void remove(removing)} />}
      <ImportDialog open={importing} onClose={(saved) => { setImporting(false); if (saved) void refresh(); }} />
    </div>
  );
}

function RuleDialog({ rule, onClose }: { rule: PincodeRuleView | null; onClose: (saved: boolean) => void }) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, getValues, formState: { errors, isSubmitting } } = useForm<RuleForm, unknown, ReturnType<typeof ruleForm.parse>>({ resolver: zodResolver(ruleForm), defaultValues: ruleToForm(rule) });
  const save = handleSubmit(async (body) => {
    setProblem(null);
    const pincode = getValues('pincode').trim();
    try { await api.request('PUT', `/admin/shipping/pincodes/${pincode}`, { body }); toast.success(`${pincode} saved`); onClose(true); }
    catch (err) { if (!applyServerErrors(err, setError, ['isServiceable', 'codAvailable', 'eddMinDays', 'eddMaxDays', 'note'])) setProblem(errorMessage(err)); }
  });
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) onClose(false); }} title={rule ? `Pincode ${rule.pincode}` : 'Add a pincode rule'} description="Overrides the default delivery policy for this pincode.">
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-4">
        <TextField id="rule-pincode" label="Pincode" inputMode="numeric" maxLength={6} readOnly={rule !== null} {...register('pincode')} error={errors.pincode?.message} />
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
