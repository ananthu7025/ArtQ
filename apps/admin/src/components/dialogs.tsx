// Dialogs shared by every module: confirmation, version conflict (409 VERSION_CONFLICT) and the password re-check for
// sensitive actions (401 STEP_UP_REQUIRED; MFA is deferred, so step-up is a password). All are Radix dialogs:
// focus is trapped, Esc closes, focus returns to the trigger.
import * as Dialog from '@radix-ui/react-dialog';
import { stepUpBody } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError, type AdminApi } from '../api/client';
import { applyServerErrors, FormAlert, TextField } from './form';

export const panel = 'fixed left-1/2 top-1/2 z-50 w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-xl outline-none';
export const overlay = 'fixed inset-0 z-40 bg-black/50';
export const btn = 'inline-flex h-11 items-center justify-center rounded-md px-4 font-medium';

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

/**
 * Installs the step-up handler on the API client: a 401 STEP_UP_REQUIRED opens this dialog; success retries the request.
 * Validated with the API's own step-up schema (CLAUDE.md "Validation rule"); a wrong password shows under the field.
 */
export function StepUpDialog({ api }: { api: AdminApi }) {
  const [pending, setPending] = useState<((ok: boolean) => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, reset, setError: setFieldError, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(stepUpBody), defaultValues: { password: '' } });

  useEffect(() => {
    api.setStepUpHandler(() => new Promise<boolean>((resolve) => { reset(); setError(null); setPending(() => resolve); }));
    return () => { api.setStepUpHandler(null); };
  }, [api, reset]);

  const finish = (ok: boolean) => { pending?.(ok); setPending(null); reset(); };
  const submit = handleSubmit(async ({ password }) => {
    setError(null);
    try {
      await api.stepUp(password);
      finish(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INVALID_CREDENTIALS') setFieldError('password', { type: 'server', message: 'That password is not correct.' }, { shouldFocus: true });
      else if (!applyServerErrors(e, setFieldError, ['password'])) setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  });

  return (
    <Dialog.Root open={pending !== null} onOpenChange={(o) => { if (!o) finish(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content className={panel}>
          <Dialog.Title className="text-lg font-semibold text-ink-900">Confirm it&apos;s you</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-ink-700">This action needs your password again.</Dialog.Description>
          <form className="mt-4 space-y-4" noValidate onSubmit={(e) => { void submit(e); }}>
            <TextField id="stepup-password" label="Password" type="password" autoComplete="current-password" {...register('password')} error={errors.password?.message} />
            {error && <FormAlert>{error}</FormAlert>}
            <div className="mt-6 flex justify-end gap-3">
              <Dialog.Close className={`${btn} text-ink-900 hover:bg-surface-100`} type="button">Cancel</Dialog.Close>
              <button type="submit" aria-busy={isSubmitting || undefined} disabled={isSubmitting} className={`${btn} bg-brand-700 text-white disabled:opacity-80`}>Confirm</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A dialog holding a form or a set of actions (Add staff, Manage staff, …). */
export function FormDialog(p: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Dialog.Root open={p.open} onOpenChange={p.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content className={panel} {...(p.description ? {} : { 'aria-describedby': undefined })}>
          <Dialog.Title className="text-lg font-semibold text-ink-900">{p.title}</Dialog.Title>
          {p.description && <Dialog.Description className="mt-2 text-sm text-ink-700">{p.description}</Dialog.Description>}
          <div className="mt-4">{p.children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
