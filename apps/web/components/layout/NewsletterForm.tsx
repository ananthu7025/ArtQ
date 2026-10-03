'use client';
// Footer newsletter (product.md §4.3, api.md §3.2). Same rule as the API (`newsletterSubscribeBody`); errors under the
// field in the on-dark error colour; the result is a toast.
import { newsletterSubscribeBody } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { apiPost, ApiError } from '../../lib/api';
import { applyServerErrors, FormAlert, TextField } from '../form/fields';

const form = newsletterSubscribeBody.pick({ email: true });
type In = z.input<typeof form>;
type Out = z.output<typeof form>;

export function NewsletterForm({ post = apiPost }: { post?: typeof apiPost }) {
  const [alert, setAlert] = useState<string | null>(null);
  const { register, handleSubmit, setError, reset, formState: { errors, isSubmitting } } = useForm<In, unknown, Out>({ resolver: zodResolver(form), defaultValues: { email: '' } });
  const submit = handleSubmit(async ({ email }) => {
    setAlert(null);
    try {
      const r = await post<{ status: 'SUBSCRIBED' | 'ALREADY_SUBSCRIBED' }>('/newsletter/subscribe', { email, source: 'footer' });
      toast(r.status === 'SUBSCRIBED' ? 'You’re subscribed. Thank you!' : 'You’re already on our list.');
      reset();
    } catch (e) {
      if (applyServerErrors(e, setError, ['email'])) return;
      setAlert(e instanceof ApiError && e.code === 'RATE_LIMITED' ? 'Too many tries. Please wait a minute and try again.' : e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    }
  });
  return (
    <form noValidate onSubmit={(e) => { void submit(e); }} className="w-full max-w-md" aria-describedby="newsletter-note">
      <div className="flex items-end gap-3">
        <TextField id="newsletter-email" label="Email address" tone="dark" type="email" autoComplete="email" inputMode="email" placeholder="Your email address"
          error={errors.email?.message} className="flex-1" {...register('email')}
          inputClassName="mt-1 block h-12 w-full border-0 border-b border-sidebar-muted bg-transparent px-0 text-base text-white placeholder:text-sidebar-muted focus:border-brand-300" />
        <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined}
          className="h-12 shrink-0 px-2 text-sm font-semibold uppercase tracking-[0.06em] text-brand-300 hover:text-white disabled:text-sidebar-muted">
          {isSubmitting ? 'Subscribing…' : 'Subscribe'}
        </button>
      </div>
      <p id="newsletter-note" className="mt-2 text-xs text-sidebar-text">New arrivals and offers, now and then. Unsubscribe any time.</p>
      {alert && <div className="mt-2"><FormAlert tone="dark">{alert}</FormAlert></div>}
    </form>
  );
}
