// Dialogs shared by every module: confirmation, version conflict (409 VERSION_CONFLICT) and the password re-check for
// sensitive actions (401 STEP_UP_REQUIRED; MFA is deferred, so step-up is a password). All are Radix dialogs:
// focus is trapped, Esc closes, focus returns to the trigger.
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, type AdminApi } from '../api/client';

const panel = 'fixed left-1/2 top-1/2 z-50 w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-xl outline-none';
const overlay = 'fixed inset-0 z-40 bg-black/50';
const btn = 'inline-flex h-11 items-center justify-center rounded-md px-4 font-medium';

export function ConfirmDialog(p: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void }) {
  return (
    <Dialog.Root open={p.open} onOpenChange={p.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content className={panel}>
          <Dialog.Title className="text-lg font-semibold text-ink-900">{p.title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-ink-700">{p.description}</Dialog.Description>
          <div className="mt-6 flex justify-end gap-3">
            <Dialog.Close className={`${btn} text-ink-900 hover:bg-surface-100`}>Cancel</Dialog.Close>
            <button type="button" aria-busy={p.busy || undefined} disabled={p.busy} onClick={p.onConfirm} className={`${btn} text-white ${p.danger ? 'bg-danger-700' : 'bg-brand-700'} disabled:opacity-80`}>{p.confirmLabel}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Shown when a save is refused because someone else changed the record first (api.md §1 optimistic concurrency). */
export function VersionConflictDialog(p: { open: boolean; entity: string; onReload: () => void; onKeepEditing: () => void }) {
  return (
    <Dialog.Root open={p.open} onOpenChange={(o) => { if (!o) p.onKeepEditing(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content className={panel} role="alertdialog">
          <Dialog.Title className="text-lg font-semibold text-ink-900">This {p.entity} was changed by someone else</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-ink-700">
            Your changes were not saved. Load the latest version to see what changed, then make your edit again, or keep editing to copy your changes first.
          </Dialog.Description>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <button type="button" onClick={p.onKeepEditing} className={`${btn} text-ink-900 hover:bg-surface-100`}>Keep editing</button>
            <button type="button" onClick={p.onReload} className={`${btn} bg-brand-700 text-white`}>Load latest version</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Installs the step-up handler on the API client: a 401 STEP_UP_REQUIRED opens this dialog; success retries the request. */
export function StepUpDialog({ api }: { api: AdminApi }) {
  const [pending, setPending] = useState<((ok: boolean) => void) | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.setStepUpHandler(() => new Promise<boolean>((resolve) => { setPassword(''); setError(null); setPending(() => resolve); }));
    return () => { api.setStepUpHandler(null); };
  }, [api]);

  const finish = (ok: boolean) => { pending?.(ok); setPending(null); setPassword(''); };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.stepUp(password);
      finish(true);
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'INVALID_CREDENTIALS' ? 'That password is not correct.' : e instanceof Error ? e.message : 'Something went wrong');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={pending !== null} onOpenChange={(o) => { if (!o) finish(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content className={panel}>
          <Dialog.Title className="text-lg font-semibold text-ink-900">Confirm it&apos;s you</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-ink-700">This action needs your password again.</Dialog.Description>
          <form className="mt-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <label htmlFor="stepup-password" className="block text-sm font-medium text-ink-900">Password</label>
            <input id="stepup-password" ref={input} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined} aria-describedby={error ? 'stepup-error' : undefined}
              className="mt-1 h-11 w-full rounded-md border border-border-input px-3 text-ink-900" />
            {error && <p id="stepup-error" role="alert" className="mt-2 text-sm text-danger-700">{error}</p>}
            <div className="mt-6 flex justify-end gap-3">
              <Dialog.Close className={`${btn} text-ink-900 hover:bg-surface-100`} type="button">Cancel</Dialog.Close>
              <button type="submit" aria-busy={busy || undefined} disabled={busy || !password} className={`${btn} bg-brand-700 text-white disabled:opacity-80`}>Confirm</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
