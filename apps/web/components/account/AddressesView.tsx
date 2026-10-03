'use client';
// /account/addresses (product.md §5.10): up to 10 saved addresses, one default (used first at checkout). Typing a
// pincode fills in the state (and the city when empty) from the postal directory; the server checks they match.
import { addressBody, ADDRESS_LABELS, MAX_ADDRESSES, type AddressView, type PincodePlace, type StateOption } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { clientRequest } from '../../lib/api';
import { CheckboxField, FormAlert, primaryButton, secondaryButton, SelectField, textLink, TextField } from '../form/fields';
import { errorText, useApi } from '../shop/ShopProvider';
import { AccountShell, Panel } from './AccountView';
import { failure, Loading, useRequireSignIn } from './auth-shared';

type In = z.input<typeof addressBody>;
type Out = z.output<typeof addressBody>;
const LABEL_TEXT: Record<(typeof ADDRESS_LABELS)[number], string> = { HOME: 'Home', WORK: 'Work', OTHER: 'Other' };
const FIELDS = ['label', 'fullName', 'phone', 'line1', 'line2', 'landmark', 'city', 'stateId', 'pincode', 'isDefault'] as const;
const title = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export function AddressesView() {
  const user = useRequireSignIn('/account/addresses');
  const api = useApi();
  const [list, setList] = useState<AddressView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState<AddressView | 'new' | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [states, setStates] = useState<StateOption[]>([]);
  const signedIn = user !== null;

  const load = useCallback(() => {
    api<{ data: AddressView[] }>('GET', '/me/addresses').then((r) => setList(r.data)).catch(() => setLoadFailed(true));
  }, [api]);
  useEffect(() => { if (signedIn) load(); }, [signedIn, load]);
  useEffect(() => { clientRequest<{ data: StateOption[] }>('GET', '/states').then((r) => setStates(r.data)).catch(() => setStates([])); }, []);

  const act = async (path: string, method: 'POST' | 'DELETE', done: string) => {
    try { setList((await api<{ data: AddressView[] }>(method, path)).data); toast(done); }
    catch (e) { toast.error(errorText(e)); }
    setConfirming(null);
  };

  if (!user) return <Loading />;
  const full = (list?.length ?? 0) >= MAX_ADDRESSES;
  return (
    <AccountShell title="Addresses">
      {editing !== null ? (
        <Panel title={editing === 'new' ? 'Add an address' : 'Edit address'} id="address-form-heading">
          <AddressForm address={editing === 'new' ? null : editing} first={(list?.length ?? 0) === 0} states={states}
            onDone={(saved) => { setEditing(null); load(); toast(saved); }} onCancel={() => setEditing(null)} />
        </Panel>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={primaryButton} disabled={full || list === null} onClick={() => setEditing('new')}>Add an address</button>
          {full && <p className="text-sm text-ink-700">You can save up to {MAX_ADDRESSES} addresses. Remove one to add another.</p>}
        </div>
      )}
      {loadFailed && <FormAlert>We could not load your addresses. <button type="button" className="underline" onClick={() => { setLoadFailed(false); load(); }}>Try again</button></FormAlert>}
      {list === null && !loadFailed && <Loading label="Loading addresses…" />}
      {list?.length === 0 && editing === null && <p className="text-ink-700">No saved addresses yet. Add one now and checkout will be quicker.</p>}
      {list && list.length > 0 && (
        <ul className="grid gap-4 md:grid-cols-2">
          {list.map((a) => (
            <li key={a.id} className="flex flex-col rounded-lg border border-surface-200 p-5">
              <p className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.06em] text-ink-900">
                {LABEL_TEXT[a.label]}{a.isDefault && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs normal-case tracking-normal text-brand-700">Default</span>}
              </p>
              <address className="mt-2 flex-1 text-sm not-italic text-ink-700">
                <span className="block font-medium text-ink-900">{a.fullName}</span>
                {a.line1}{a.line2 ? `, ${a.line2}` : ''}<br />
                {a.landmark && <>Near {a.landmark}<br /></>}
                {a.city}, {a.state.name} {a.pincode}<br />
                Phone {a.phone}
              </address>
              {confirming === a.id ? (
                <div role="group" aria-label={`Remove the ${LABEL_TEXT[a.label]} address of ${a.fullName}?`} className="mt-4 flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-ink-900">Remove this address?</span>
                  <button type="button" className="font-semibold text-danger-700 underline" onClick={() => { void act(`/me/addresses/${a.id}`, 'DELETE', 'Address removed'); }}>Remove</button>
                  <button type="button" className={textLink} onClick={() => setConfirming(null)}>Keep</button>
                </div>
              ) : (
                <div className="mt-4 flex flex-wrap gap-4 text-sm">
                  <button type="button" className={textLink} onClick={() => setEditing(a)} aria-label={`Edit ${LABEL_TEXT[a.label]} address of ${a.fullName}`}>Edit</button>
                  {!a.isDefault && <button type="button" className={textLink} onClick={() => { void act(`/me/addresses/${a.id}/default`, 'POST', 'Default address changed'); }} aria-label={`Make ${LABEL_TEXT[a.label]} address of ${a.fullName} the default`}>Make default</button>}
                  <button type="button" className={textLink} onClick={() => setConfirming(a.id)} aria-label={`Remove ${LABEL_TEXT[a.label]} address of ${a.fullName}`}>Remove</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </AccountShell>
  );
}

export function AddressForm({ address, first, states, onDone, onCancel }: { address: AddressView | null; first: boolean; states: StateOption[]; onDone: (message: string) => void; onCancel: () => void }) {
  const api = useApi();
  const [problem, setProblem] = useState<string | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  const looked = useRef(address?.pincode ?? '');
  const { register, handleSubmit, setError, setValue, getValues, control, formState: { errors, isSubmitting } } = useForm<In, unknown, Out>({
    resolver: zodResolver(addressBody),
    defaultValues: address
      ? { label: address.label, fullName: address.fullName, phone: address.phone, line1: address.line1, line2: address.line2 ?? '', landmark: address.landmark ?? '', city: address.city, stateId: address.state.id, pincode: address.pincode, isDefault: address.isDefault }
      : { label: 'HOME', fullName: '', phone: '', line1: '', line2: '', landmark: '', city: '', pincode: '', isDefault: first },
  });
  const pincode = useWatch({ control, name: 'pincode' });
  // A complete pincode fills in the state, and the city when it is still empty.
  useEffect(() => {
    if (!/^[1-9]\d{5}$/.test(pincode ?? '') || pincode === looked.current) return;
    looked.current = pincode!;
    let live = true;
    clientRequest<PincodePlace>('GET', `/pincodes/${pincode}`).then((p) => {
      if (!live) return;
      setValue('stateId', p.state.id, { shouldDirty: true });
      if (!getValues('city')?.trim()) setValue('city', title(p.district), { shouldDirty: true });
      setPlace(`${title(p.district)}, ${p.state.name}`);
    }).catch(() => { if (live) setPlace(null); });
    return () => { live = false; };
  }, [pincode, setValue, getValues]);

  const submit = handleSubmit(async (body) => {
    setProblem(null);
    try {
      await api(address ? 'PATCH' : 'POST', address ? `/me/addresses/${address.id}` : '/me/addresses', body);
      onDone(address ? 'Address saved' : 'Address added');
    } catch (e) { setProblem(failure(e, setError, FIELDS)); }
  });
  return (
    <form noValidate onSubmit={(e) => { void submit(e); }} className="grid gap-5 md:grid-cols-2">
      <fieldset className="md:col-span-2">
        <legend className="text-[13px] font-medium text-ink-900">Save as</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {ADDRESS_LABELS.map((l) => (
            <label key={l} className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-full border border-border-input px-4 text-sm text-ink-900 has-[:checked]:border-brand-700 has-[:checked]:bg-brand-50 has-[:checked]:text-brand-700">
              <input type="radio" value={l} className="accent-brand-700" {...register('label')} />{LABEL_TEXT[l]}
            </label>
          ))}
        </div>
      </fieldset>
      <TextField id="addr-name" label="Full name" autoComplete="name" error={errors.fullName?.message} {...register('fullName')} />
      <TextField id="addr-phone" label="Mobile number" type="tel" autoComplete="tel" inputMode="tel" error={errors.phone?.message}
        {...register('phone', { setValueAs: (v: string) => v.replace(/[\s-]/g, '') })} />
      <div>
        <TextField id="addr-pincode" label="Pincode" inputMode="numeric" autoComplete="postal-code" maxLength={6} error={errors.pincode?.message} {...register('pincode')} />
        <p role="status" className="mt-1 text-sm text-ink-500">{place && !errors.pincode ? place : ''}</p>
      </div>
      <SelectField id="addr-state" label="State" error={errors.stateId?.message} {...register('stateId', { setValueAs: (v: string | number) => (v === '' || v === undefined ? undefined : Number(v)) })}>
        <option value="">Choose a state</option>
        {address && !states.some((s) => s.id === address.state.id) && <option value={address.state.id}>{address.state.name}</option>}
        {states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </SelectField>
      <div className="md:col-span-2"><TextField id="addr-line1" label="House / flat, building and street" autoComplete="address-line1" error={errors.line1?.message} {...register('line1')} /></div>
      <TextField id="addr-line2" label="Area / locality (optional)" autoComplete="address-line2" error={errors.line2?.message} {...register('line2')} />
      <TextField id="addr-landmark" label="Landmark (optional)" error={errors.landmark?.message} {...register('landmark')} />
      <TextField id="addr-city" label="City / town" autoComplete="address-level2" error={errors.city?.message} {...register('city')} />
      <div className="flex items-end pb-3">
        {address?.isDefault
          ? <p className="text-sm text-ink-700">This is your default address.</p>
          : <CheckboxField id="addr-default" label="Use as my default address" {...register('isDefault')} />}
      </div>
      {problem && <div className="md:col-span-2"><FormAlert>{problem}</FormAlert></div>}
      <div className="flex flex-wrap gap-3 md:col-span-2">
        <button type="submit" disabled={isSubmitting} className={primaryButton}>{isSubmitting ? 'Saving…' : address ? 'Save address' : 'Add address'}</button>
        <button type="button" className={secondaryButton} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
