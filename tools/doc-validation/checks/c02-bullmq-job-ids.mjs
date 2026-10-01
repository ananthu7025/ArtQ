// Finding 2: BullMQ custom job ids. Uses a real Redis and the pinned BullMQ (plus 6.x for comparison).
import { createRequire } from 'node:module';
import * as bull5 from 'bullmq';
import * as bull6 from 'bullmq6';
import { eq, assert } from '../lib/db.mjs';
const require = createRequire(import.meta.url);

async function probe(lib, connection, name) {
  const q = new lib.Queue(name, { connection });
  const tryAdd = async (id) => { try { await q.add('x', {}, { jobId: id }); return 'accepted'; } catch (e) { return 'rejected: ' + e.message; } };
  const r = {
    'wh:42': await tryAdd('wh:42'),
    'outbox:17:email.customer': await tryAdd('outbox:17:email.customer'),
    'wh-42': await tryAdd('wh-42'),
    'outbox-17-3': await tryAdd('outbox-17-3'),
  };
  await q.add('x', { dup: true }, { jobId: 'outbox-17-3' });          // duplicate add while job exists
  const counts = await q.getJobCounts('waiting');
  const job = await q.getJob('outbox-17-3');
  await q.obliterate({ force: true }); await q.close();
  return { r, waiting: counts.waiting, dupPayloadIgnored: !job.data.dup };
}

export default {
  id: 'C02', title: 'BullMQ custom job ids (colon rejected, hyphen accepted, duplicate add deduplicated)', needs: ['redis'],
  async run({ redis }) {
    const v5 = require('bullmq/package.json').version, v6 = require('bullmq6/package.json').version;
    const a = await probe(bull5, redis.connection, 'ids5');
    const b = await probe(bull6, redis.connection, 'ids6');
    for (const [v, x] of [[v5, a], [v6, b]]) {
      assert(x.r['wh:42'].startsWith('rejected'), `${v}: wh:42 must be rejected`);
      eq(x.r['wh-42'], 'accepted', `${v}: wh-42`); eq(x.r['outbox-17-3'], 'accepted', `${v}: outbox-17-3`);
      assert(x.dupPayloadIgnored, `${v}: duplicate jobId must not replace the existing job`);
    }
    return `bullmq ${v5} (pinned): wh:42 → ${a.r['wh:42']}; outbox:17:email.customer → ${a.r['outbox:17:email.customer']}; ` +
           `hyphen ids accepted; duplicate jobId ignored (waiting=${a.waiting}). bullmq ${v6}: wh:42 → ${b.r['wh:42']}; ` +
           `3-part colon id → ${b.r['outbox:17:email.customer']}`;
  },
};
