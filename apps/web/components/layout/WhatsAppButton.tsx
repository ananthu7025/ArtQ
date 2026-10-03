// Floating WhatsApp button (product.md §4.4). Hidden until the owner enters a number in Settings. A product page passes
// the product name so the chat starts with it.
import { whatsappHref } from '@artq/shared';
import { MessageCircle } from 'lucide-react';

export function WhatsAppButton({ number, productName }: { number: string | null; productName?: string }) {
  const href = whatsappHref(number, productName ? `Hi ArtQ, I have a question about ${productName}` : undefined);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-whatsapp text-white shadow-lg hover:bg-whatsapp-dark">
      <MessageCircle aria-hidden size={28} strokeWidth={1.75} />
      <span className="sr-only">Chat with us on WhatsApp (opens WhatsApp)</span>
    </a>
  );
}
