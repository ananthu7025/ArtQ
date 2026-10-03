'use client';
// Delivery check on the product page (product.md §5.3): a pincode (shared rule) → deliverable?, COD?, estimated days.
// Being a real pincode does not make it deliverable; an unknown one is probably mistyped. The last pincode is kept in
// this browser for the next product.
import { pincodeForm, type PincodeCheck as Check } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, MapPin, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { clientRequest } from '../../lib/api';
import { FormAlert, TextField } from '../form/fields';
import { errorText } from '../shop/ShopProvider';

const KEY = 'aq_pincode';
const title = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export function PincodeCheck() {
  const [result, setResult] = useState<Check | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setValue, formState: { errors, isSubmitting } } = useForm<z.input<typeof pincodeForm>, unknown, z.output<typeof pincodeForm>>({ resolver: zodResolver(pincodeForm), defaultValues: { pincode: '' } });
  useEffect(() => { try { const saved = window.localStorage.getItem(KEY); if (saved && /^[1-9]\d{5}$/.test(saved)) setValue('pincode', saved); } catch { /* storage blocked */ } }, [setValue]);
  const submit = handleSubmit(async ({ pincode }) => {
    setProblem(null);
    try {
      setResult(await clientRequest<Check>('GET', `/pincodes/${pincode}/serviceability`));
      try { window.localStorage.setItem(KEY, pincode); } catch { /* storage blocked */ }
    } catch (e) { setResult(null); setProblem(errorText(e)); }
  });
  return (
    <section aria-labelledby="delivery-heading" className="rounded-lg border border-surface-200 p-4">
      <h2 id="delivery-heading" className="flex items-center gap-2 text-sm font-semibold text-ink-900"><MapPin aria-hidden size={16} />Check delivery</h2>
      <form noValidate onSubmit={(e) => { void submit(e); }} className="mt-2 flex items-start gap-2">
        <TextField id="pincode" label="Pincode" hideLabel inputMode="numeric" autoComplete="postal-code" maxLength={6} placeholder="Enter pincode" error={errors.pincode?.message} className="flex-1" {...register('pincode')} />
        <button type="submit" disabled={isSubmitting} className="mt-1 h-12 shrink-0 rounded-md border-[1.5px] border-ink-900 px-4 text-sm font-semibold uppercase tracking-[0.06em] text-ink-900 hover:bg-ink-900 hover:text-white md:h-11">{isSubmitting ? 'Checking…' : 'Check'}</button>
      </form>
      {problem && <div className="mt-2"><FormAlert>{problem}</FormAlert></div>}
      <div role="status" className="mt-2 text-sm">
        {result && result.serviceable && (
          <p className="flex gap-2 text-success-700"><CheckCircle2 aria-hidden size={18} className="shrink-0" />
            <span>Delivers to {result.place ? `${title(result.place.district)}, ${result.place.state}` : result.pincode}{result.estimatedDays ? ` in ${result.estimatedDays.min}–${result.estimatedDays.max} days` : ''}.{' '}
              {result.codAvailable ? 'Cash on delivery available.' : 'Prepaid only (no cash on delivery here).'}</span></p>
        )}
        {result && result.reason === 'NOT_SERVICEABLE' && <p className="flex gap-2 text-danger-700"><XCircle aria-hidden size={18} className="shrink-0" />Sorry, we don’t deliver to {result.pincode} yet.</p>}
        {result && result.reason === 'UNKNOWN_PINCODE' && <p className="flex gap-2 text-danger-700"><XCircle aria-hidden size={18} className="shrink-0" />We couldn’t find pincode {result.pincode}. Please check the number.</p>}
      </div>
    </section>
  );
}
