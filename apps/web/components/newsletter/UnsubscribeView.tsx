'use client';
// The unsubscribe page body (task 6.3): checks the link with the shared rule before asking the API, shows the masked
// address, and unsubscribes on the button (again is harmless). A bad or unknown link says so plainly.
import { NEWSLETTER_TOKEN, type NewsletterUnsubscribeView } from '@artq/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, apiPost, clientRequest } from '../../lib/api';
import { FormAlert, primaryButton } from '../form/fields';

type State = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'error'; message: string } | { kind: 'ready'; view: NewsletterUnsubscribeView };
const INVALID = 'This unsubscribe link isn’t valid. Use the link from your most recent ArtQ email, or write to us from the Contact page.';
const failure = (e: unknown): State => (e instanceof ApiError && (e.code === 'NOT_FOUND' || e.code === 'VALIDATION_ERROR') ? { kind: 'invalid' } : { kind: 'error', message: e instanceof Error ? e.message : 'Something went wrong. Please try again.' });

export function UnsubscribeView({ token }: { token: string | null }) {
  const valid = token !== null && NEWSLETTER_TOKEN.test(token);
  const [state, setState] = useState<State>(valid ? { kind: 'loading' } : { kind: 'invalid' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!valid) return;
    let live = true;
    clientRequest<NewsletterUnsubscribeView>('GET', `/newsletter/unsubscribe?token=${token}`)
      .then((view) => { if (live) setState({ kind: 'ready', view }); }, (e: unknown) => { if (live) setState(failure(e)); });
    return () => { live = false; };
  }, [token, valid]);

  const unsubscribe = async () => {
    setBusy(true); setProblem(null);
    try { setState({ kind: 'ready', view: await apiPost<NewsletterUnsubscribeView>('/newsletter/unsubscribe', { token }) }); }
    catch (e) { const s = failure(e); if (s.kind === 'invalid') setState(s); else setProblem(s.kind === 'error' ? s.message : null); }
    finally { setBusy(false); }
  };

  if (state.kind === 'loading') return <p className="mt-4 text-ink-700" role="status">Checking your link…</p>;
  if (state.kind === 'invalid') return <p className="mt-4 text-ink-800" role="alert">{INVALID}</p>;
  if (state.kind === 'error') return <div className="mt-4"><FormAlert>{state.message}</FormAlert></div>;
  const { email, status } = state.view;
  if (status === 'UNSUBSCRIBED') return (
    <div className="mt-4 space-y-3" role="status">
      <p className="text-ink-800"><strong className="text-ink-900">{email}</strong> is unsubscribed. You won’t get our newsletter any more.</p>
      <p className="text-sm text-ink-700">Changed your mind? Sign up again from the form at the bottom of any page. Order emails still come as usual.</p>
      <Link href="/" className="inline-block font-medium text-brand-700 underline underline-offset-2">Back to the shop</Link>
    </div>
  );
  return (
    <div className="mt-4 space-y-4">
      <p className="text-ink-800">Stop sending the ArtQ newsletter to <strong className="text-ink-900">{email}</strong>? Order and delivery emails are not affected.</p>
      {problem && <FormAlert>{problem}</FormAlert>}
      <button type="button" className={primaryButton} disabled={busy} onClick={() => void unsubscribe()}>{busy ? 'Unsubscribing…' : 'Unsubscribe'}</button>
    </div>
  );
}
