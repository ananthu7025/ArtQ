'use client';
// Mobile menu drawer (product.md §4.2, design-system.md §5.8): from the left, 85 % wide (max 380 px), focus trapped,
// Esc or the close button closes it and focus returns to ☰. Types expand to their categories.
import type { Navigation } from '@artq/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { NAV_LINKS } from './links';

export function MobileDrawer({ open, onOpenChange, navigation, returnFocus }: { open: boolean; onOpenChange: (o: boolean) => void; navigation: Navigation; returnFocus?: () => void }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const row = 'flex min-h-12 w-full items-center justify-between px-5 text-left text-[15px] text-ink-900 hover:bg-surface-100';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/50" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-[55] flex w-[85vw] max-w-[380px] flex-col bg-white shadow-xl focus:outline-none" aria-describedby={undefined}
          onCloseAutoFocus={(e) => { if (returnFocus) { e.preventDefault(); returnFocus(); } }}>
          <div className="flex h-[60px] items-center justify-between border-b border-surface-200 px-5">
            <Dialog.Title className="font-display text-lg font-semibold text-ink-900">Menu</Dialog.Title>
            <Dialog.Close className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-surface-100" aria-label="Close menu"><X aria-hidden size={22} /></Dialog.Close>
          </div>
          <nav aria-label="Mobile" className="flex-1 overflow-y-auto overscroll-contain py-2">
            <ul>
              <li><Link href="/" className={row}>Home</Link></li>
              <li>
                <p className="font-eyebrow px-5 pb-1 pt-4 text-[12px] uppercase tracking-[0.12em] text-ink-700">Shop</p>
                <ul>
                  {navigation.types.map((t) => {
                    const isOpen = expanded === t.id;
                    return (
                      <li key={t.id}>
                        {t.categories.length === 0
                          ? <Link href={t.href} className={row}>{t.name}</Link>
                          : (
                            <>
                              <button type="button" className={row} aria-expanded={isOpen} aria-controls={`drawer-type-${t.id}`} onClick={() => setExpanded(isOpen ? null : t.id)}>
                                {t.name}<ChevronDown aria-hidden size={18} className={isOpen ? 'rotate-180' : ''} />
                              </button>
                              <ul id={`drawer-type-${t.id}`} hidden={!isOpen} className="bg-surface-50 pb-2">
                                <li><Link href={t.href} className={`${row} pl-9 font-medium text-brand-700`}>All {t.name}</Link></li>
                                {t.categories.map((c) => <li key={c.id}><Link href={`/category/${c.slug}`} className={`${row} pl-9 text-ink-700`}>{c.name}</Link></li>)}
                              </ul>
                            </>
                          )}
                      </li>
                    );
                  })}
                </ul>
              </li>
              {NAV_LINKS.slice(1).map((l) => <li key={l.href}><Link href={l.href} className={row}>{l.label}</Link></li>)}
            </ul>
          </nav>
          <div className="border-t border-surface-200 p-5">
            <Link href="/login" className="flex h-12 w-full items-center justify-center rounded-md bg-brand-700 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800">Log in / Sign up</Link>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
