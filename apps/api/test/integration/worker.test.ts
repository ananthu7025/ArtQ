import { Queue, QueueEvents } from 'bullmq';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jobId } from '../../src/jobs/ids.js';
import type { QueueDef, SchedulerDef } from '../../src/jobs/registry.js';
import { createWorkerRuntime } from '../../src/worker/runtime.js';
import { startRedis } from '../helpers/services.js';

let rd: Awaited<ReturnType<typeof startRedis>>;
let connection: { host: string; port: number };
const log = pino({ level: 'silent' });
beforeAll(async () => { rd = await startRedis(); const u = new URL(rd.url); connection = { host: u.hostname, port: Number(u.port) }; }, 60_000);
afterAll(async () => { await rd?.stop(); });

let n = 0;
let qname: string;
beforeEach(() => { qname = `t${++n}${Date.now()}`; });

const counter = () => { const seen: unknown[] = []; const def = (over: Partial<QueueDef> = {}): QueueDef => ({ name: qname, concurrency: 1, processor: async (j) => { seen.push(j.data); return 'ok'; }, ...over }); return { seen, def }; };
const sched = (everyMs = 60_000): SchedulerDef => ({ queue: qname, id: 'heartbeat', everyMs, jobName: 'heartbeat' });
const until = async (fn: () => boolean | Promise<boolean>, ms = 10_000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('condition not met'); await new Promise((r) => setTimeout(r, 50)); } };

describe('worker runtime (real Redis)', () => {
  it('processes jobs added with a safe deterministic id (happy path)', async () => {
    const c = counter();
    const rt = createWorkerRuntime({ connection, log, queues: [c.def()], schedulers: [] });
    await rt.start();
    await rt.queues.get(qname)!.add('ping', { n: 1 }, { jobId: jobId('ping', 1) });
    await until(() => c.seen.length === 1);
    await rt.stop();
    expect(c.seen).toEqual([{ n: 1 }]);
  });

  it('a duplicate deterministic job id is processed once', async () => {
    const c = counter();
    const rt = createWorkerRuntime({ connection, log, queues: [c.def()], schedulers: [] });
    const q = new Queue(qname, { connection });
    await q.add('x', { n: 1 }, { jobId: jobId('dup', 1) });
    await q.add('x', { n: 2 }, { jobId: jobId('dup', 1) });
    await rt.start();
    await until(() => c.seen.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    await rt.stop(); await q.close();
    expect(c.seen).toEqual([{ n: 1 }]);
  });

  it('registers the scheduler and fires it', async () => {
    const c = counter();
    const rt = createWorkerRuntime({ connection, log, queues: [c.def()], schedulers: [sched(200)] });
    await rt.start();
    await until(() => c.seen.length >= 2, 5000);
    const schedulers = await rt.queues.get(qname)!.getJobSchedulers();
    await rt.stop();
    expect(schedulers.map((s) => s.key)).toEqual(['heartbeat']);
  });

  it('restarting the worker re-registers schedulers without duplicating them, and updates the interval', async () => {
    const c = counter();
    for (const every of [60_000, 60_000, 30_000]) {
      const rt = createWorkerRuntime({ connection, log, queues: [c.def()], schedulers: [sched(every)] });
      await rt.start(); await rt.stop();
    }
    const q = new Queue(qname, { connection });
    const s = await q.getJobSchedulers();
    await q.close();
    expect(s).toHaveLength(1);
    expect(s[0]!.every).toBe(30_000);
  });

  it('a failing job is retried with backoff and then marked failed; the worker keeps running', async () => {
    let calls = 0;
    const rt = createWorkerRuntime({ connection, log, schedulers: [],
      queues: [{ name: qname, concurrency: 1, attempts: 3, backoffMs: 20, processor: async (j) => { calls++; if (j.data.fail) throw new Error('boom'); return 'ok'; } }] });
    await rt.start();
    const q = rt.queues.get(qname)!;
    const ev = new QueueEvents(qname, { connection }); await ev.waitUntilReady();
    const bad = await q.add('x', { fail: true }, { jobId: jobId('bad', 1) });
    await expect(bad.waitUntilFinished(ev, 10_000)).rejects.toThrow('boom');
    const good = await q.add('x', { fail: false }, { jobId: jobId('good', 1) });
    await expect(good.waitUntilFinished(ev, 10_000)).resolves.toBe('ok');
    const state = await q.getJobState(bad.id!);
    await ev.close(); await rt.stop();
    expect(state).toBe('failed');
    expect(calls).toBe(4);   // 3 attempts + 1 good job
  });

  it('jobs added while stopped are processed after restart (nothing lost)', async () => {
    const c = counter();
    const rt1 = createWorkerRuntime({ connection, log, queues: [c.def()], schedulers: [] });
    await rt1.start(); await rt1.stop();
    const q = new Queue(qname, { connection });
    await q.add('x', { n: 9 }, { jobId: jobId('later', 9) });
    await q.close();
    expect(c.seen).toEqual([]);
    const rt2 = createWorkerRuntime({ connection, log, queues: [c.def()], schedulers: [] });
    await rt2.start();
    await until(() => c.seen.length === 1);
    await rt2.stop();
    expect(c.seen).toEqual([{ n: 9 }]);
  });

  it('rejects a scheduler that targets an unknown queue', async () => {
    const c = counter();
    const rt = createWorkerRuntime({ connection, log, queues: [c.def()], schedulers: [{ queue: 'nope', id: 'x', everyMs: 1000, jobName: 'x' }] });
    await expect(rt.start()).rejects.toThrow(/unknown queue/);
    await rt.stop();
  });

  it('start() fails fast when Redis is unreachable', async () => {
    const c = counter();
    const rt = createWorkerRuntime({ connection: { host: '127.0.0.1', port: 1, maxRetriesPerRequest: null, retryStrategy: () => 1000 }, log, queues: [c.def()], schedulers: [], readyTimeoutMs: 500 });
    await expect(rt.start()).rejects.toThrow(/not ready after 500 ms/);
    await rt.stop();
  });
});
