import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { QueueDef, SchedulerDef } from '../jobs/registry.js';

export type WorkerRuntime = { start(): Promise<void>; stop(): Promise<void>; queues: Map<string, Queue> };

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} not ready after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Worker process runtime (task 0.5): one Queue + Worker per definition; schedulers are (re)registered with
 * upsertJobScheduler at every start, so a restarted worker re-creates missing schedulers and never duplicates them.
 */
export function createWorkerRuntime(opts: { connection: ConnectionOptions; log: Logger; queues: QueueDef[]; schedulers: SchedulerDef[]; readyTimeoutMs?: number }): WorkerRuntime {
  const queues = new Map<string, Queue>();
  const workers: Worker[] = [];
  return {
    queues,
    async start() {
      const known = new Set(opts.queues.map((q) => q.name));
      for (const s of opts.schedulers) if (!known.has(s.queue)) throw new Error(`scheduler ${s.id} targets unknown queue ${s.queue}`);
      for (const def of opts.queues) {
        const q = new Queue(def.name, {
          connection: opts.connection,
          defaultJobOptions: { attempts: def.attempts ?? 8, backoff: { type: 'exponential', delay: def.backoffMs ?? 5000 },
                               removeOnComplete: { age: 7 * 86400 }, removeOnFail: { age: 30 * 86400 } },
        });
        queues.set(def.name, q);
        await timeout(q.waitUntilReady(), opts.readyTimeoutMs ?? 10_000, `queue ${def.name}`);
        const w = new Worker(def.name, def.processor, { connection: opts.connection, concurrency: def.concurrency });
        w.on('failed', (job, err) => opts.log.warn({ queue: def.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
        w.on('error', (err) => opts.log.error({ queue: def.name, err: err.message }, 'worker error'));
        workers.push(w);
        // Wait until the worker's blocking connection is open, so a stop() right after start() closes cleanly.
        await timeout(w.waitUntilReady(), opts.readyTimeoutMs ?? 10_000, `worker ${def.name}`);
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
