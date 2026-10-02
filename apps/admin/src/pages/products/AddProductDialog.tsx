// Add Product (product.md §7.3): name + optional type/category → a new DRAFT, then the editor.
// Validated with the API's own create schema (CLAUDE.md "Validation rule").
import { createProductBody } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { btn, FormDialog } from '../../components/dialogs';
import { useFeedbackMutation } from '../../components/feedback';
import { applyServerErrors, FormAlert, SelectField, TextField } from '../../components/form';

export type TypeOption = { id: number; name: string };
export type CategoryOption = { id: number; name: string; typeId: number };

const addSchema = createProductBody.pick({ name: true, typeId: true, categoryId: true });
const toId = (v: unknown) => (v === '' || v === undefined || v === null ? undefined : Number(v));

export function AddProductDialog({ open, onOpenChange, types }: { open: boolean; onOpenChange: (o: boolean) => void; types: TypeOption[] }) {
  const { api } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api.request<{ data: CategoryOption[] }>('GET', '/admin/categories'), enabled: open });
  const { register, handleSubmit, control, reset, setValue, setError: setFieldError, formState: { errors } } = useForm({ resolver: zodResolver(addSchema) });
  const typeId = useWatch({ control, name: 'typeId' });
  const shown = (categories.data?.data ?? []).filter((c) => !typeId || c.typeId === typeId);
  const create = useFeedbackMutation<{ name: string; typeId?: number | null | undefined; categoryId?: number | null | undefined }, { id: number; name: string }>({
    mutationFn: (v) => api.request('POST', '/admin/products', { body: v }),
    success: (p) => `Draft “${p.name}” created`,
    onError: (e) => { if (!applyServerErrors(e, setFieldError, ['name', 'typeId', 'categoryId'])) setError(e instanceof Error ? e.message : 'Something went wrong'); },
    invalidate: [['products'], ['product-types']],
  });
  const close = (o: boolean) => { if (!o) { reset(); setError(null); } onOpenChange(o); };
  const typeField = register('typeId', { setValueAs: toId, onChange: () => setValue('categoryId', undefined) });

  return (
    <FormDialog open={open} onOpenChange={close} title="Add product" description="It starts as a draft. You can fill in everything else in the editor.">
      <form className="space-y-4" noValidate onSubmit={handleSubmit((v) => { setError(null); create.mutate(v, { onSuccess: (p) => { close(false); void navigate(`/products/${p.id}`); } }); })}>
        <TextField id="product-name" label="Name" autoComplete="off" {...register('name')} error={errors.name?.message} />
        <SelectField id="product-type" label="Product type (optional)" {...typeField} error={errors.typeId?.message}>
          <option value="">Unassigned</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </SelectField>
        <SelectField id="product-category" label="Category (optional)" {...register('categoryId', { setValueAs: toId })} error={errors.categoryId?.message}
          hint={typeId ? undefined : 'Choosing a category also sets its type.'}>
          <option value="">None yet</option>
          {shown.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        {error && <FormAlert>{error}</FormAlert>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className={`${btn} text-ink-900 hover:bg-surface-100`} onClick={() => close(false)}>Cancel</button>
          <button type="submit" disabled={create.isPending} aria-busy={create.isPending || undefined} className={`${btn} bg-brand-700 text-white disabled:opacity-80`}>{create.isPending ? 'Creating…' : 'Create draft'}</button>
        </div>
      </form>
    </FormDialog>
  );
}
