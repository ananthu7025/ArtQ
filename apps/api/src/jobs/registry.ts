import type { Job } from 'bullmq';

export type Processor = (job: Job) => Promise<unknown>;

/** A repeatable job (BullMQ job scheduler). Registered with upsert, so restarts never duplicate it. */
export type SchedulerDef = { queue: string; id: string; everyMs: number; jobName: string; data?: Record<string, unknown> };

export type QueueDef = { name: string; concurrency: number; processor: Processor; attempts?: number; backoffMs?: number };

export const QUEUE = { maintenance: 'maintenance', outboxDispatch: 'outbox.dispatch', webhookProcess: 'webhook.process', mediaProcess: 'media.process', searchReindex: 'search.reindex', importValidate: 'import.validate', importApply: 'import.apply' } as const;
