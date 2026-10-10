'use client';
// Toasts (design-system.md §5.8): ink-900 with white text, 5 s, paused while hovered or focused; announced politely.
import { Toaster } from 'sonner';

export function SiteToaster() {
  return <Toaster position="bottom-center" duration={5000} toastOptions={{ unstyled: true, classNames: { toast: 'flex w-[min(92vw,380px)] items-start gap-3 rounded-md bg-ink-900 px-4 py-3 text-sm text-white shadow-lg', title: 'font-medium', description: 'text-sidebar-text', actionButton: 'ml-auto shrink-0 rounded px-2 py-1 font-semibold text-brand-300 underline underline-offset-2 hover:text-white' } }} />;
}
