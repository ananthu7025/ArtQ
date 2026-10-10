// Redirect lookup only (task 6.4; architecture.md §4): the owner's redirects for addresses the shop does not serve
// (lib/redirects.ts). The matcher skips every address in SEO_RESERVED_PREFIXES (@artq/shared; a test keeps the two in
// step), Next.js internals and files, so ordinary shop pages never wait for a lookup.
import { NextResponse, type NextRequest } from 'next/server';
import { redirectFor } from './lib/redirects';

export async function proxy(request: NextRequest) {
  const to = await redirectFor(request.nextUrl);
  return to ? NextResponse.redirect(to.url, to.status) : NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!(?:_next|api|account|cart|checkout|login|signup|forgot-password|reset-password|set-password|track|newsletter|wishlist|search|product|type|category|technique|shop|new-arrivals|trending)(?:/|$))(?!.*\\.[A-Za-z0-9]+$).+)',
  ],
};
