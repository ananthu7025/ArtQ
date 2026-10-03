'use client';
// Search overlay (product.md §4.2): the search box with live suggestions (SearchForm); results on /search?q=.
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { SearchForm } from './SearchForm';

export function SearchDialog({ open, onOpenChange, returnFocus }: { open: boolean; onOpenChange: (o: boolean) => void; returnFocus?: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/50" />
        <Dialog.Content className="fixed inset-x-0 top-0 z-[60] bg-white px-4 py-5 shadow-xl focus:outline-none md:px-8" aria-describedby={undefined}
          onOpenAutoFocus={(e) => { e.preventDefault(); document.getElementById('site-search')?.focus(); }}
          onCloseAutoFocus={(e) => { if (returnFocus) { e.preventDefault(); returnFocus(); } }}>
          <div className="mx-auto max-w-[760px]">
            <div className="mb-3 flex items-center justify-between">
              <Dialog.Title className="font-display text-xl font-semibold text-ink-900">Search the store</Dialog.Title>
              <Dialog.Close className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-surface-100" aria-label="Close search"><X aria-hidden size={22} /></Dialog.Close>
            </div>
            <SearchForm onDone={() => onOpenChange(false)} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
