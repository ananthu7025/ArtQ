// BullMQ rejects custom job ids containing ':' (verified on 5.81.5 / 6.3.11, doc-validation C02).
// Deterministic ids are built from safe parts joined with '-', e.g. jobId('outbox', 42, 3) → 'outbox-42-3'.
const PART = /^[A-Za-z0-9_.]+$/;

export function jobId(...parts: (string | number)[]): string {
  if (parts.length === 0) throw new TypeError('jobId needs at least one part');
  const out = parts.map((p) => {
    const s = String(p);
    if (!PART.test(s)) throw new TypeError(`invalid jobId part ${JSON.stringify(s)}: use letters, digits, '_' or '.'`);
    return s;
  });
  const id = out.join('-');
  if (/^\d+$/.test(id)) throw new TypeError('jobId must not be purely numeric');
  if (id.length > 128) throw new TypeError('jobId too long');
  return id;
}
