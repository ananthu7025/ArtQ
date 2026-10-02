// /products/:id until the full editor (task 2.5): the product's key facts and its publication checklist.
import { formatINR } from '@artq/shared';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { FormAlert } from '../../components/form';
import { PageHeader } from '../simple';
import { StatusPill } from './parts';

type Detail = {
  id: number; name: string; status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; type: { name: string } | null; category: { name: string } | null;
  aggregates: { minPrice: number | null; maxPrice: number | null; available: number; activeVariants: number };
  readiness: { ready: boolean; failures: { code: string; check: string; fix: string }[] };
};

export function ProductSummaryPage() {
  const { api } = useAuth();
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const q = useQuery({ queryKey: ['product', id], queryFn: () => api.request<Detail>('GET', `/admin/products/${id}`), enabled: valid });
  if (!valid || q.isError) {
    return (
      <>
        <PageHeader title="Product" />
        <FormAlert>{q.error instanceof Error ? q.error.message : 'Product not found'}. <Link to="/products" className="underline">Back to products</Link></FormAlert>
      </>
    );
  }
  if (!q.data) return <p className="text-ink-700">Loading…</p>;
  const p = q.data;
  const price = p.aggregates.minPrice === null ? 'No price'
    : p.aggregates.minPrice === p.aggregates.maxPrice ? formatINR(p.aggregates.minPrice) : `${formatINR(p.aggregates.minPrice)}–${formatINR(p.aggregates.maxPrice!)}`;
  return (
    <>
      <PageHeader title={p.name}><StatusPill status={p.status} /></PageHeader>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-surface-200 bg-white p-5" aria-labelledby="facts">
          <h2 id="facts" className="font-semibold text-ink-900">Summary</h2>
          <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-ink-700">Type</dt><dd className="text-ink-900">{p.type?.name ?? 'Unassigned'}</dd>
            <dt className="text-ink-700">Category</dt><dd className="text-ink-900">{p.category?.name ?? 'None'}</dd>
            <dt className="text-ink-700">Price</dt><dd className="text-ink-900">{price}</dd>
            <dt className="text-ink-700">Active variants</dt><dd className="text-ink-900">{p.aggregates.activeVariants}</dd>
            <dt className="text-ink-700">Available</dt><dd className="text-ink-900">{p.aggregates.available}</dd>
          </dl>
          <p className="mt-4 text-sm text-ink-700">The full product editor arrives with task 2.5. Variants can already be edited from the Products page.</p>
        </section>
        <section className="rounded-lg border border-surface-200 bg-white p-5" aria-labelledby="ready">
          <h2 id="ready" className="font-semibold text-ink-900">Ready to publish?</h2>
          {p.readiness.ready
            ? <p className="mt-3 flex items-center gap-2 text-success-700"><Check aria-hidden size={18} /> Every check passes.</p>
            : <ul className="mt-3 space-y-2 text-sm">{p.readiness.failures.map((f) => <li key={f.code}><span className="font-semibold text-ink-900">{f.check}:</span> <span className="text-ink-700">{f.fix}</span></li>)}</ul>}
        </section>
      </div>
      <Link to="/products" className="mt-6 inline-block font-medium text-brand-700 underline">Back to products</Link>
    </>
  );
}
