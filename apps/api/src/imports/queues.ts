// How the API and the worker queue import jobs (architecture.md §8.4 `import.apply`).
// Validation retries every 5 s while the uploaded file is still being checked by media processing (up to 5 minutes).
// Apply jobs get a fresh id each time: re-queuing (sweeper, a second confirm click) is harmless because batches are
// serialised by an advisory lock and only PENDING rows are processed.
import type { Queue } from 'bullmq';
import { jobId } from '../jobs/ids.js';
import type { ImportDeps } from './service.js';

export function importEnqueue(validate: Queue, apply: Queue): ImportDeps['enqueue'] {
  return {
    validate: async (id, createMissing) => {
      await validate.add('validate', { id, createMissing }, { jobId: jobId('import_validate', id, Date.now()), attempts: 60, backoff: { type: 'fixed', delay: 5000 }, removeOnComplete: true });
    },
    apply: async (id) => {
      await apply.add('apply', { id }, { jobId: jobId('import_apply', id, Date.now()), attempts: 1, removeOnComplete: true });
    },
  };
}
