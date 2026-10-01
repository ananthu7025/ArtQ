// India Post "All India Pincode Directory" (data.gov.in CSV) → postal_codes (geography only; database.md §3.2).
// Required columns (case-insensitive): officename, pincode, district, statename. Other columns are ignored.
// Re-running with the same file changes nothing; a newer file updates district/state of existing (pincode, office) rows.
import { readFile } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { STATE_ALIASES, STATES } from './reference-data.js';
import { SeedError, withSeedLock, type StepResult } from './steps.js';

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;     // BOM
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (quoted) throw new SeedError('CSV ends inside a quoted field');
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

const CANONICAL = new Map(STATES.map((s) => [key(s.name), s.name]));
/** Comparison key: upper case, "&" → AND, punctuation removed, leading "THE " dropped. */
function key(name: string): string {
  return name.toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z]+/g, ' ').trim().replace(/^THE /, '');
}

/** Directory state name → canonical state name, or null when unknown. */
export function canonicalStateName(raw: string): string | null {
  const k = key(raw);
  return CANONICAL.get(k) ?? (STATE_ALIASES[k] ? STATE_ALIASES[k]! : null);
}

/** Title-cases directory text ("ERNAKULAM" → "Ernakulam"), keeping dotted abbreviations such as "H.O" upper case. */
export function tidy(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
    .replace(/(^|\s)((?:[a-z]\.)+[a-z]?\.?)(?=\s|$)/gi, (m) => m.toUpperCase());
}

export type PostalRow = { pincode: string; officeName: string; district: string; stateName: string };
export type ParsedDirectory = { rows: PostalRow[]; skipped: { line: number; reason: string }[] };

export function parseDirectory(text: string): ParsedDirectory {
  const table = parseCsv(text);
  if (table.length === 0) throw new SeedError('postal code file is empty');
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new SeedError(`postal code file has no "${name}" column (found: ${header.join(', ')})`);
    return i;
  };
  const [cOffice, cPin, cDistrict, cState] = [col('officename'), col('pincode'), col('district'), col('statename')];
  const byKey = new Map<string, PostalRow>();
  const skipped: ParsedDirectory['skipped'] = [];
  table.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    const pincode = (cells[cPin] ?? '').trim();
    const officeName = tidy(cells[cOffice] ?? '');
    const district = tidy(cells[cDistrict] ?? '');
    const stateName = canonicalStateName(cells[cState] ?? '');
    if (!/^[1-9]\d{5}$/.test(pincode)) return skipped.push({ line, reason: `invalid pincode "${pincode}"` });
    if (!officeName || officeName.length > 120) return skipped.push({ line, reason: 'missing or over-long office name' });
    if (!district || district.length > 80) return skipped.push({ line, reason: 'missing or over-long district' });
    if (!stateName) return skipped.push({ line, reason: `unknown state "${cells[cState] ?? ''}"` });
    byKey.set(`${pincode}|${officeName}`, { pincode, officeName, district, stateName });   // duplicates: last row wins
  });
  return { rows: [...byKey.values()], skipped };
}

/** Upserts the directory in batches; returns created/updated/unchanged counts and skipped-row notes. */
export async function seedPostalCodes(prisma: PrismaClient, file: string, batchSize = 2000): Promise<StepResult & { skipped: number }> {
  const { rows, skipped } = parseDirectory(await readFile(file, 'utf8'));
  const states = await prisma.state.findMany({ select: { id: true, name: true } });
  const stateIds = new Map(states.map((s) => [s.name, s.id]));
  if (stateIds.size === 0) throw new SeedError('no states: run the geo step first');
  const r = { created: 0, updated: 0, unchanged: 0, notes: [] as string[], skipped: skipped.length };
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const counts = await withSeedLock(prisma, async (tx) => {
      const res = await tx.$queryRaw<{ inserted: boolean }[]>`
        INSERT INTO postal_codes (pincode, office_name, district, state_id)
        SELECT * FROM unnest(${batch.map((b) => b.pincode)}::text[], ${batch.map((b) => b.officeName)}::text[],
                             ${batch.map((b) => b.district)}::text[], ${batch.map((b) => stateIds.get(b.stateName)!)}::int[])
        ON CONFLICT (pincode, office_name) DO UPDATE SET district = EXCLUDED.district, state_id = EXCLUDED.state_id
          WHERE (postal_codes.district, postal_codes.state_id) IS DISTINCT FROM (EXCLUDED.district, EXCLUDED.state_id)
        RETURNING (xmax = 0) AS inserted`;
      return { created: res.filter((x) => x.inserted).length, updated: res.filter((x) => !x.inserted).length };
    });
    r.created += counts.created;
    r.updated += counts.updated;
    r.unchanged += batch.length - counts.created - counts.updated;
  }
  for (const s of skipped.slice(0, 20)) r.notes.push(`line ${s.line}: ${s.reason}`);
  if (skipped.length > 20) r.notes.push(`… ${skipped.length - 20} more skipped rows`);
  return r;
}
