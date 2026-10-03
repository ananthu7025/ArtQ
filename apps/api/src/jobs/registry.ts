import type { Job } from 'bullmq';

export type Processor = (job: Job) => Promise<unknown>;

/** A repeatable job (BullMQ job scheduler). Registered with upsert, so restarts never duplicate it. */
export type SchedulerDef = { queue: string; id: string; everyMs: number; jobName: string; data?: Record<string, unknown> };

export type QueueDef = { name: string; concurrency: number; processor: Processor; attempts?: number; backoffMs?: number };

export const QUEUE = { maintenance: 'maintenance', outboxDispatch: 'outbox.dispatch', webhookProcess: 'webhook.process', mediaProcess: 'media.process', searchReindex: 'search.reindex', importValidate: 'import.validate', importApply: 'import.apply' } as const;

/**
 * Options every BullMQ Queue/Worker gets. skipVersionCheck: BullMQ otherwise sends INFO on connect and splits the reply;
 * during startup that reply was occasionally not text ("doc.split is not a function"), and BullMQ then keeps the failed
 * setup, so that queue never works until a restart. Redis is pinned (7.x, docs/compatibility.md) and some managed
 * Redis services block INFO, so the check adds nothing.
 */
export const BULLMQ_BASE = { skipVersionCheck: true } as const;
