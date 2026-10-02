// Mutation feedback (product.md §7.2): busy button (via mutation.isPending), success toast, error toast or inline error,
// optimistic update with rollback, and a version-conflict hook for 409 VERSION_CONFLICT.
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '../api/client';

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'FORBIDDEN') return 'You do not have permission to do this.';
    if (e.code === 'NETWORK') return e.message;
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong';
}

export type FeedbackOptions<V, R, Snapshot> = {
  mutationFn: (vars: V) => Promise<R>;
  success?: string | ((r: R, v: V) => string);
  /** Optimistic update: return a snapshot; it is restored if the mutation fails. */
  optimistic?: { queryKey: QueryKey; apply: (current: Snapshot | undefined, vars: V) => Snapshot | undefined };
  /** Called for 409 VERSION_CONFLICT instead of a toast (show VersionConflictDialog). */
  onConflict?: (e: ApiError) => void;
  /** Called for other errors instead of a toast (inline error display). */
  onError?: (e: unknown) => void;
  invalidate?: QueryKey[];
};

export function useFeedbackMutation<V, R = unknown, Snapshot = unknown>(o: FeedbackOptions<V, R, Snapshot>) {
  const qc = useQueryClient();
  return useMutation<R, unknown, V, { previous: Snapshot | undefined } | undefined>({
    mutationFn: o.mutationFn,
    onMutate: async (vars) => {
      if (!o.optimistic) return undefined;
      await qc.cancelQueries({ queryKey: o.optimistic.queryKey });
      const previous = qc.getQueryData<Snapshot>(o.optimistic.queryKey);
      qc.setQueryData<Snapshot | undefined>(o.optimistic.queryKey, (cur) => o.optimistic!.apply(cur, vars));
      return { previous };
    },
    onError: (e, _vars, ctx) => {
      if (o.optimistic && ctx) qc.setQueryData(o.optimistic.queryKey, ctx.previous);
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT' && o.onConflict) { o.onConflict(e); return; }
      if (o.onError) { o.onError(e); return; }
      toast.error(errorMessage(e));
    },
    onSuccess: (r, v) => {
      if (o.success) toast.success(typeof o.success === 'function' ? o.success(r, v) : o.success);
    },
    onSettled: async () => {
      for (const key of o.invalidate ?? []) await qc.invalidateQueries({ queryKey: key });
      if (o.optimistic) await qc.invalidateQueries({ queryKey: o.optimistic.queryKey });
    },
  });
}
