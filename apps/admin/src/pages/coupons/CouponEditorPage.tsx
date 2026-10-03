// Create / edit a coupon (/coupons/new, /coupons/:id). Validation = the shared couponBody after converting rupees,
// percent and local dates (coupon-form.ts); server field errors land on the same fields. Once used, the discount (type
// and value) is locked: the API refuses it (409 COUPON_IN_USE) and the form says so up front.
import { COUPON_SCOPES, couponSummary, type CouponAdminView, type CouponData, type ProductListRow, type RedemptionView } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Controller, useForm, useWatch, type Control } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ApiError, type Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { btn, ConfirmDialog } from '../../components/dialogs';
import { errorMessage, useFeedbackMutation } from '../../components/feedback';
import { applyServerErrors, FormAlert, SelectField, TextField } from '../../components/form';
import { PageHeader } from '../simple';
import { couponForm, EMPTY_COUPON, FORM_FIELDS, fromCoupon, type CouponFormValues } from './coupon-form';
import { StatePill, usesText } from './CouponsPage';

const SCOPE_LABEL: Record<(typeof COUPON_SCOPES)[number], string> = { ALL: 'Every product', TYPES: 'Product types', CATEGORIES: 'Categories', PRODUCTS: 'Chosen products' };
const section = 'rounded-lg border border-surface-200 bg-white p-5';
const check = 'flex items-start gap-3 text-sm text-ink-900';

function Check({ id, label, help, ...input }: { id: string; label: string; help?: string } & React.InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <div className={check}>
      <input id={id} type="checkbox" className="mt-0.5 h-5 w-5 accent-brand-700" aria-describedby={help ? `${id}-help` : undefined} {...input} />
      <div><label htmlFor={id} className="font-medium">{label}</label>{help && <p id={`${id}-help`} className="text-ink-700">{help}</p>}</div>
    </div>
  );
}

export function CouponEditorPage() {
  const { id } = useParams();
  const { api } = useAuth();
  const isNew = id === 'new';
  const query = useQuery({ queryKey: ['coupon', id], queryFn: () => api.request<CouponAdminView>('GET', `/admin/coupons/${id}`), enabled: !isNew });
  if (!isNew && query.isPending) return <p role="status" className="text-ink-700">Loading coupon…</p>;
  if (!isNew && query.isError) {
    return (
      <div className="space-y-4">
        <Link to="/coupons" className="inline-flex items-center gap-1 text-brand-700"><ArrowLeft size={16} aria-hidden />Coupons</Link>
        <FormAlert>{query.error instanceof ApiError && query.error.status === 404 ? 'This coupon does not exist (it may have been deleted).' : errorMessage(query.error)}</FormAlert>
      </div>
    );
  }
  return <CouponEditor key={query.data?.updatedAt ?? 'new'} coupon={query.data ?? null} />;
}

function CouponEditor({ coupon }: { coupon: CouponAdminView | null }) {
  const { api } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const locked = coupon?.hasRedemptions === true;
  const { register, handleSubmit, control, setError, formState: { errors, isSubmitting, isDirty } } = useForm<CouponFormValues, unknown, CouponData>({
    resolver: zodResolver(couponForm), defaultValues: coupon ? fromCoupon(coupon) : EMPTY_COUPON,
  });
  const type = useWatch({ control, name: 'type' });
  const appliesTo = useWatch({ control, name: 'appliesTo' });

  const save = handleSubmit(async (body) => {
    setProblem(null);
    try {
      const saved = coupon
        ? await api.request<CouponAdminView>('PUT', `/admin/coupons/${coupon.id}`, { body })
        : await api.request<CouponAdminView>('POST', '/admin/coupons', { body });
      toast.success(coupon ? `${saved.code} saved` : `${saved.code} created`);
      await qc.invalidateQueries({ queryKey: ['coupons'] });
      qc.setQueryData(['coupon', String(saved.id)], saved);
      if (!coupon) navigate(`/coupons/${saved.id}`, { replace: true });
    } catch (e) {
      if (applyServerErrors(e, setError, FORM_FIELDS)) return;
      setProblem(e instanceof ApiError && e.code === 'COUPON_IN_USE' ? 'This coupon has been used, so its discount cannot change. Create a new coupon instead.' : errorMessage(e));
    }
  });
  const remove = useFeedbackMutation<void>({
    mutationFn: () => api.request('DELETE', `/admin/coupons/${coupon!.id}`), success: `${coupon?.code ?? 'Coupon'} deleted`, invalidate: [['coupons']],
  });

  return (
    <>
      <Link to="/coupons" className="mb-3 inline-flex items-center gap-1 text-brand-700"><ArrowLeft size={16} aria-hidden />Coupons</Link>
      <PageHeader title={coupon ? coupon.code : 'New coupon'}>
        {coupon && <div className="flex items-center gap-3"><StatePill state={coupon.state} /><span className="text-sm text-ink-700">{usesText(coupon)}</span></div>}
      </PageHeader>
      <form noValidate onSubmit={(e) => { void save(e); }} className="max-w-3xl space-y-5">
        <section aria-labelledby="c-basics" className={section}>
          <h2 id="c-basics" className="mb-4 font-semibold text-ink-900">Code and title</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <TextField id="coupon-code" label="Code" autoComplete="off" spellCheck={false} className="[&_input]:uppercase" hint="Customers type this. Letters, numbers, - or _ (not case-sensitive)." {...register('code')} error={errors.code?.message} />
            <TextField id="coupon-title" label="Title" hint="Shown to customers, e.g. “Welcome offer”." {...register('title')} error={errors.title?.message} />
            <div className="md:col-span-2">
              <label htmlFor="coupon-description" className="block text-sm font-medium text-ink-900">Description (optional)</label>
              <textarea id="coupon-description" rows={2} {...register('description')} aria-invalid={errors.description ? true : undefined} aria-describedby={errors.description ? 'coupon-description-error' : undefined}
                className="mt-1 block w-full rounded-md border border-border-input bg-white px-3 py-2 text-ink-900" />
              {errors.description && <p id="coupon-description-error" className="mt-1 text-sm text-danger-700">{errors.description.message}</p>}
            </div>
          </div>
        </section>

        <section aria-labelledby="c-discount" className={section}>
          <h2 id="c-discount" className="mb-1 font-semibold text-ink-900">Discount</h2>
          {locked && <p className="mb-3 text-sm text-ink-700">This coupon has been used, so its discount type and amount are locked. Create a new coupon to offer a different discount.</p>}
          <fieldset className="mb-4" disabled={locked}>
            <legend className="sr-only">Discount type</legend>
            <div className="flex flex-wrap gap-2">
              {([['PERCENT', 'Percentage off'], ['FLAT', 'Amount off (₹)'], ['FREE_SHIPPING', 'Free shipping']] as const).map(([v, label]) => (
                <label key={v} className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-md border border-border-input px-4 text-sm has-[:checked]:border-brand-700 has-[:checked]:bg-brand-50 has-[:checked]:text-brand-700 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70">
                  <input type="radio" value={v} className="accent-brand-700" {...register('type')} />{label}
                </label>
              ))}
            </div>
            {errors.type && <p className="mt-1 text-sm text-danger-700">{errors.type.message}</p>}
          </fieldset>
          <div className="grid gap-4 md:grid-cols-2">
            {type === 'PERCENT' && <TextField id="coupon-value" label="Percentage (%)" inputMode="numeric" disabled={locked} {...register('value')} error={errors.value?.message} />}
            {type === 'FLAT' && <TextField id="coupon-value" label="Amount off (₹)" inputMode="decimal" disabled={locked} {...register('value')} error={errors.value?.message} />}
            {type === 'PERCENT' && <TextField id="coupon-max" label="Maximum discount (₹, optional)" inputMode="decimal" hint="Leave empty for no maximum." {...register('maxDiscount')} error={errors.maxDiscount?.message} />}
            {type === 'FREE_SHIPPING' && <p className="text-sm text-ink-700 md:col-span-2">Shipping is free (up to 10 kg; heavier orders pay the extra per kg). Items keep their prices.</p>}
            <TextField id="coupon-min" label="Minimum order (₹, optional)" inputMode="decimal" hint="Counts only the items the coupon applies to." {...register('minOrderValue')} error={errors.minOrderValue?.message} />
          </div>
        </section>

        <section aria-labelledby="c-scope" className={section}>
          <h2 id="c-scope" className="mb-4 font-semibold text-ink-900">Applies to</h2>
          <SelectField id="coupon-scope" label="Products" className="max-w-xs" {...register('appliesTo')} error={errors.appliesTo?.message}>
            {COUPON_SCOPES.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
          </SelectField>
          {appliesTo !== 'ALL' && <TargetPicker key={appliesTo} scope={appliesTo} control={control} error={errors.targetIds?.message ?? (errors.targetIds as unknown as { root?: { message?: string } } | undefined)?.root?.message} initial={coupon?.appliesTo === appliesTo ? coupon.targets : []} />}
        </section>

        <section aria-labelledby="c-limits" className={section}>
          <h2 id="c-limits" className="mb-4 font-semibold text-ink-900">When and how often</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <TextField id="coupon-starts" label="Starts (optional)" type="datetime-local" hint="Empty = from now." {...register('startsAt')} error={errors.startsAt?.message} />
            <TextField id="coupon-ends" label="Ends (optional)" type="datetime-local" hint="Empty = no end date." {...register('endsAt')} error={errors.endsAt?.message} />
            <TextField id="coupon-total" label="Total uses (optional)" inputMode="numeric" hint="Across all customers. Empty = no limit." {...register('usageLimitTotal')} error={errors.usageLimitTotal?.message} />
            <TextField id="coupon-per" label="Uses per customer (optional)" inputMode="numeric" hint="Empty = no limit. Guests are matched by email." {...register('usageLimitPerCustomer')} error={errors.usageLimitPerCustomer?.message} />
          </div>
          <div className="mt-4"><Check id="coupon-first" label="First order only" help="Only for customers with no earlier order." {...register('firstOrderOnly')} /></div>
        </section>

        <section aria-labelledby="c-visibility" className={section}>
          <h2 id="c-visibility" className="mb-4 font-semibold text-ink-900">Visibility</h2>
          <div className="space-y-3">
            <Check id="coupon-active" label="On" help="Turn off to stop the coupon working at once (orders already placed keep it)." {...register('isActive')} />
            <Check id="coupon-public" label="Show to customers" help="Listed in the cart’s “Available coupons”. Hidden coupons work only for people who know the code." {...register('isPublic')} />
          </div>
        </section>

        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined} className={`${btn} bg-brand-700 text-white disabled:opacity-80`}>{isSubmitting ? 'Saving…' : coupon ? 'Save coupon' : 'Create coupon'}</button>
          <Link to="/coupons" className={`${btn} text-ink-900 hover:bg-surface-100`}>{isDirty ? 'Cancel' : 'Back'}</Link>
          {coupon && <button type="button" onClick={() => setDeleting(true)} className={`${btn} ml-auto text-danger-700 hover:bg-[#fee2e2]`}>Delete coupon</button>}
        </div>
      </form>
      {coupon && <Redemptions coupon={coupon} />}
      {coupon && (
        <ConfirmDialog open={deleting} onOpenChange={setDeleting} title={`Delete ${coupon.code}?`} danger busy={remove.isPending} confirmLabel="Delete"
          description="It stops working at once and is removed from carts. Orders that used it keep it. The code cannot be used for a new coupon."
          onConfirm={() => remove.mutate(undefined, { onSuccess: () => { setDeleting(false); navigate('/coupons'); } })} />
      )}
    </>
  );
}

type Option = { id: number; name: string; hint?: string };

/** Choose types or categories (checkbox list) or products (search, then add). */
function TargetPicker({ scope, control, error, initial }: { scope: 'TYPES' | 'CATEGORIES' | 'PRODUCTS'; control: Control<CouponFormValues, unknown, CouponData>; error: string | undefined; initial: Option[] }) {
  const { api } = useAuth();
  const list = useQuery({
    queryKey: ['coupon-targets', scope],
    enabled: scope !== 'PRODUCTS',
    queryFn: async (): Promise<Option[]> => {
      if (scope === 'TYPES') return (await api.request<{ data: { id: number; name: string }[] }>('GET', '/admin/product-types')).data;
      const [types, cats] = await Promise.all([api.request<{ data: { id: number; name: string }[] }>('GET', '/admin/product-types'), api.request<{ data: { id: number; name: string; typeId: number }[] }>('GET', '/admin/categories')]);
      const typeName = new Map(types.data.map((t) => [t.id, t.name]));
      return cats.data.map((c) => ({ id: c.id, name: c.name, hint: typeName.get(c.typeId) ?? '' }));
    },
  });
  const [names, setNames] = useState<Map<number, string>>(() => new Map(initial.map((o) => [o.id, o.name])));
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => { const t = setTimeout(() => setSearch(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const found = useQuery({
    queryKey: ['coupon-product-search', search], enabled: scope === 'PRODUCTS' && search.length >= 2,
    queryFn: () => api.request<Page<ProductListRow>>('GET', '/admin/products', { query: { q: search, limit: 10 } }),
  });
  const label = scope === 'TYPES' ? 'Product types' : scope === 'CATEGORIES' ? 'Categories' : 'Products';
  return (
    <Controller control={control} name="targetIds" render={({ field }) => {
      const chosen = field.value;
      const toggle = (o: Option) => {
        setNames((m) => new Map(m).set(o.id, o.name));
        field.onChange(chosen.includes(o.id) ? chosen.filter((x) => x !== o.id) : [...chosen, o.id]);
      };
      return (
        <fieldset className="mt-4" aria-describedby={error ? 'coupon-targets-error' : undefined} aria-invalid={error ? true : undefined}>
          <legend className="text-sm font-medium text-ink-900">{label} the coupon applies to</legend>
          {scope !== 'PRODUCTS' ? (
            list.isPending ? <p role="status" className="mt-2 text-sm text-ink-700">Loading…</p>
              : list.isError ? <FormAlert>Couldn’t load the list. <button type="button" className="underline" onClick={() => void list.refetch()}>Retry</button></FormAlert>
                : (
                  <ul className={`mt-2 grid max-h-72 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2 ${error ? 'border-danger-700' : 'border-surface-200'}`}>
                    {list.data.map((o) => (
                      <li key={o.id}>
                        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded px-2 text-sm text-ink-900 hover:bg-surface-100">
                          <input type="checkbox" className="h-5 w-5 accent-brand-700" checked={chosen.includes(o.id)} onChange={() => toggle(o)} />
                          <span>{o.name}{o.hint && <span className="text-ink-700"> · {o.hint}</span>}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )
          ) : (
            <div className="mt-2 space-y-3">
              {chosen.length > 0 && (
                <ul aria-label="Chosen products" className="flex flex-wrap gap-2">
                  {chosen.map((pid) => (
                    <li key={pid} className="inline-flex items-center gap-1 rounded-full bg-surface-100 py-1 pl-3 pr-1 text-sm text-ink-900">
                      {names.get(pid) ?? `#${pid}`}
                      <button type="button" aria-label={`Remove ${names.get(pid) ?? `product ${pid}`}`} onClick={() => field.onChange(chosen.filter((x) => x !== pid))} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-surface-200"><X size={14} aria-hidden /></button>
                    </li>
                  ))}
                </ul>
              )}
              <div>
                <label htmlFor="coupon-product-search" className="block text-sm text-ink-900">Find products</label>
                <input id="coupon-product-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a product name"
                  aria-invalid={error ? true : undefined} aria-describedby={error ? 'coupon-targets-error' : undefined} className="mt-1 block h-11 w-full max-w-md rounded-md border border-border-input bg-white px-3 text-ink-900" />
              </div>
              {search.length >= 2 && (
                <ul aria-label="Search results" className="max-w-md divide-y divide-surface-200 rounded-md border border-surface-200">
                  {found.isPending && <li role="status" className="p-3 text-sm text-ink-700">Searching…</li>}
                  {found.data?.data.length === 0 && <li className="p-3 text-sm text-ink-700">No products match “{search}”.</li>}
                  {found.data?.data.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 p-2 pl-3 text-sm">
                      <span className="text-ink-900">{p.name}{p.type && <span className="text-ink-700"> · {p.type.name}</span>}</span>
                      <button type="button" onClick={() => toggle(p)} className={`${btn} h-9 border border-border-input text-sm`} aria-label={`${chosen.includes(p.id) ? 'Remove' : 'Add'} ${p.name}`}>{chosen.includes(p.id) ? 'Remove' : 'Add'}</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {error && <p id="coupon-targets-error" className="mt-1 text-sm text-danger-700">{error}</p>}
        </fieldset>
      );
    }} />
  );
}

const STATUS_TEXT: Record<RedemptionView['status'], string> = { RESERVED: 'At checkout', REDEEMED: 'Used', RELEASED: 'Released (unpaid)', REVERSED: 'Given back (cancelled)' };
const when = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function Redemptions({ coupon }: { coupon: CouponAdminView }) {
  const { api } = useAuth();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['coupon-redemptions', coupon.id, page], queryFn: () => api.request<Page<RedemptionView>>('GET', `/admin/coupons/${coupon.id}/redemptions`, { query: { page, limit: 20 } }), placeholderData: (p) => p });
  return (
    <section aria-labelledby="c-redemptions" className={`${section} mt-8 max-w-3xl`}>
      <h2 id="c-redemptions" className="font-semibold text-ink-900">Orders that used {coupon.code}</h2>
      <p className="text-sm text-ink-700">{couponSummary(coupon)}</p>
      {q.isPending ? <p role="status" className="mt-3 text-sm text-ink-700">Loading…</p>
        : q.isError ? <div className="mt-3"><FormAlert>Couldn’t load. <button type="button" className="underline" onClick={() => void q.refetch()}>Retry</button></FormAlert></div>
          : q.data.data.length === 0 ? <p className="mt-3 text-sm text-ink-700">No orders yet.</p> : (
            <>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Orders that used {coupon.code}</caption>
                  <thead><tr className="border-b border-surface-200 text-ink-700"><th scope="col" className="py-2 pr-3 font-medium">Order</th><th scope="col" className="py-2 pr-3 font-medium">Customer</th><th scope="col" className="py-2 pr-3 font-medium">Discount</th><th scope="col" className="py-2 pr-3 font-medium">Status</th><th scope="col" className="py-2 font-medium">Date</th></tr></thead>
                  <tbody>
                    {q.data.data.map((r) => (
                      <tr key={r.id} className="border-b border-surface-100">
                        <td className="py-2 pr-3 font-mono">{r.orderNumber}</td>
                        <td className="py-2 pr-3">{r.customer.email}{r.customer.userId === null && <span className="text-ink-700"> (guest)</span>}</td>
                        <td className="py-2 pr-3">₹{(r.discount / 100).toLocaleString('en-IN')}</td>
                        <td className="py-2 pr-3">{STATUS_TEXT[r.status]}{r.overLimit && <span className="ml-1 text-warning-ink">· over the limit</span>}</td>
                        <td className="py-2 whitespace-nowrap">{when.format(new Date(r.redeemedAt ?? r.reservedAt))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {q.data.meta.totalPages > 1 && (
                <div className="mt-3 flex items-center gap-3 text-sm">
                  <button type="button" className={`${btn} border border-border-input`} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
                  <span>Page {page} of {q.data.meta.totalPages}</span>
                  <button type="button" className={`${btn} border border-border-input`} disabled={page >= q.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
                </div>
              )}
            </>
          )}
    </section>
  );
}
