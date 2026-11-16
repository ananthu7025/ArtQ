import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';
import { BULLMQ_BASE, type QueueDef, type SchedulerDef } from '../jobs/registry.js';

export type WorkerRuntime = { start(): Promise<void>; stop(): Promise<void>; queues: Map<string, Queue> };

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} not ready after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Job history retention. Count-bounded on purpose: the outbox dispatcher runs every second and the search reindexer every
 * two, so an age-only rule (7 days) kept ~600k completed jobs per queue and filled Redis (maxmemory + noeviction), which
 * stopped all queue writes. `count` caps the worst case regardless of schedule frequency; `age` trims quiet queues sooner.
 */
export const REMOVE_ON_COMPLETE = { age: 3600, count: 500 } as const;
export const REMOVE_ON_FAIL = { age: 30 * 86400, count: 5000 } as const;

/**
 * Rate-limits a repeating log line. A dependency outage (e.g. Redis refusing writes) makes BullMQ emit an error on every
 * poll retry; logging each one wrote ~1 GB/hour to syslog and filled the disk. Logs the first occurrence of a message,
 * then at most one summary per `intervalMs` with the number of occurrences suppressed.
 */
export function createThrottledLogger(log: (fields: Record<string, unknown>, msg: string) => void, intervalMs = 60_000, now: () => number = Date.now) {
  const state = new Map<string, { last: number; suppressed: number }>();
  return (key: string, fields: Record<string, unknown>, msg: string): void => {
    const t = now();
    const s = state.get(key);
    if (!s) { state.set(key, { last: t, suppressed: 0 }); log(fields, msg); return; }
    if (t - s.last < intervalMs) { s.suppressed++; return; }
    log({ ...fields, suppressed: s.suppressed }, msg);
    s.last = t; s.suppressed = 0;
  };
}

/**
 * Worker process runtime (task 0.5): one Queue + Worker per definition; schedulers are (re)registered with
 * upsertJobScheduler at every start, so a restarted worker re-creates missing schedulers and never duplicates them.
 */
export function createWorkerRuntime(opts: {
  connection: ConnectionOptions; log: Logger; queues: QueueDef[]; schedulers: SchedulerDef[]; readyTimeoutMs?: number;
  /** Queues this process only adds jobs to (e.g. outbox consumers whose workers run elsewhere or arrive later). */
  producers?: string[];
  /** BullMQ key prefix (default "bull"); tests use a unique one per file so a shared Redis never mixes their jobs. */
  prefix?: string;
}): WorkerRuntime {
  const prefix = { ...BULLMQ_BASE, ...(opts.prefix ? { prefix: opts.prefix } : {}) };
  const queues = new Map<string, Queue>();
  const workers: Worker[] = [];
  const logWorkerError = createThrottledLogger((f, m) => opts.log.error(f, m));
  return {
    queues,
    async start() {
      const known = new Set(opts.queues.map((q) => q.name));
      for (const s of opts.schedulers) if (!known.has(s.queue)) throw new Error(`scheduler ${s.id} targets unknown queue ${s.queue}`);
      for (const def of opts.queues) {
        const q = new Queue(def.name, {
          connection: opts.connection, ...prefix,
          defaultJobOptions: { attempts: def.attempts ?? 8, backoff: { type: 'exponential', delay: def.backoffMs ?? 5000 },
                               removeOnComplete: REMOVE_ON_COMPLETE, removeOnFail: REMOVE_ON_FAIL },
        });
        queues.set(def.name, q);
        await timeout(q.waitUntilReady(), opts.readyTimeoutMs ?? 10_000, `queue ${def.name}`);
        const w = new Worker(def.name, def.processor, { connection: opts.connection, concurrency: def.concurrency, ...prefix });
        w.on('failed', (job, err) => opts.log.warn({ queue: def.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
        w.on('error', (err) => logWorkerError(`${def.name}:${err.message}`, { queue: def.name, err: err.message }, 'worker error'));
        workers.push(w);
        // Wait until the worker's blocking connection is open, so a stop() right after start() closes cleanly.
        await timeout(w.waitUntilReady(), opts.readyTimeoutMs ?? 10_000, `worker ${def.name}`);
      }
      for (const name of opts.producers ?? []) {
        if (queues.has(name)) continue;
        const q = new Queue(name, { connection: opts.connection, ...prefix, defaultJobOptions: { attempts: 8, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: REMOVE_ON_COMPLETE, removeOnFail: REMOVE_ON_FAIL } });
        queues.set(name, q);
        await timeout(q.waitUntilReady(), opts.readyTimeoutMs ?? 10_000, `queue ${name}`);
      }
      for (const s of opts.schedulers) {
        await queues.get(s.queue)!.upsertJobScheduler(s.id, { every: s.everyMs }, { name: s.jobName, data: s.data ?? {} });
      }
      opts.log.info({ queues: [...queues.keys()], schedulers: opts.schedulers.map((s) => s.id) }, 'worker runtime started');
    },
    async stop() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
      workers.length = 0;
      queues.clear();
    },
  };
}
