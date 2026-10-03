'use client';
// Search overlay (product.md §4.2). Opens /search?q=; live suggestions arrive with task 3.7. The query follows the
// shared rule (`searchForm`), shown on the field like every other form.
import { searchForm } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import * as Dialog from '@radix-ui/react-dialog';
import { Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { TextField } from '../form/fields';

export function SearchDialog({ open, onOpenChange, returnFocus }: { open: boolean; onOpenChange: (o: boolean) => void; returnFocus?: () => void }) {
  const router = useRouter();
  const { register, handleSubmit, reset, setFocus, formState: { errors } } = useForm<z.input<typeof searchForm>, unknown, z.output<typeof searchForm>>({ resolver: zodResolver(searchForm), defaultValues: { q: '' } });
  const submit = handleSubmit(({ q }) => { onOpenChange(false); reset(); router.push(`/search?q=${encodeURIComponent(q)}`); });
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/50" />
        <Dialog.Content className="fixed inset-x-0 top-0 z-[60] bg-white px-4 py-5 shadow-xl focus:outline-none md:px-8" aria-describedby={undefined}
          onOpenAutoFocus={(e) => { e.preventDefault(); setFocus('q'); }}
          onCloseAutoFocus={(e) => { if (returnFocus) { e.preventDefault(); returnFocus(); } }}>
          <div className="mx-auto max-w-[760px]">
            <div className="mb-3 flex items-center justify-between">
              <Dialog.Title className="font-display text-xl font-semibold text-ink-900">Search the store</Dialog.Title>
              <Dialog.Close className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-surface-100" aria-label="Close search"><X aria-hidden size={22} /></Dialog.Close>
            </div>
            <form role="search" noValidate onSubmit={(e) => { void submit(e); }} className="flex items-start gap-2">
              <TextField id="site-search" label="Search products" hideLabel type="search" autoComplete="off" enterKeyHint="search" placeholder="Resin, frames, pigments…" error={errors.q?.message} className="flex-1" {...register('q')} />
              <button type="submit" className="inline-flex h-12 shrink-0 items-center gap-2 rounded-md bg-brand-700 px-4 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800 md:h-11 mt-1">
                <Search aria-hidden size={18} /><span>Search</span>
              </button>
            </form>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
