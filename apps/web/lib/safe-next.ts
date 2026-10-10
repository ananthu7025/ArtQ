// Where to go after signing in: only a path on this site (never another host, never a protocol-relative URL).
export function safeNext(next: string | null | undefined, fallback = '/account'): string {
  return next && /^\/(?![/\\])/.test(next) ? next : fallback;
}
