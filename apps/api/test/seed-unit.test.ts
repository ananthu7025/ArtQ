import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import { canonicalStateName, parseCsv, parseDirectory, tidy } from '../src/seed/postal.js';
import { STATE_ALIASES, STATES, ZONES } from '../src/seed/reference-data.js';
import { adminFromEnv, formatReport, parseArgs } from '../src/seed/run.js';
import { SeedError } from '../src/seed/steps.js';

describe('reference data', () => {
  it('36 states/UTs with unique names, codes and GST state codes', () => {
    expect(STATES).toHaveLength(36);
    for (const k of ['name', 'code', 'gstCode'] as const) expect(new Set(STATES.map((s) => s[k])).size).toBe(36);
    expect(STATES.every((s) => /^\d{2}$/.test(s.gstCode) && s.code.length <= 4)).toBe(true);
    expect(STATES.map((s) => s.gstCode)).not.toContain('25');      // merged into 26
    expect(STATES.find((s) => s.name === 'Kerala')).toMatchObject({ gstCode: '32', zone: 'KERALA' });
  });

  it('every state maps to a defined zone and every zone has states', () => {
    const keys = new Set(ZONES.map((z) => z.key));
    expect(STATES.every((s) => keys.has(s.zone))).toBe(true);
    for (const z of ZONES) expect(STATES.some((s) => s.zone === z.key)).toBe(true);
    expect(STATES.filter((s) => s.zone === 'SOUTH').map((s) => s.code).sort()).toEqual(['AP', 'KA', 'PY', 'TN', 'TS']);
  });

  it('zones match the product.md §8.2 rate table', () => {
    expect(ZONES.map((z) => [z.name, z.slabs.map((s) => s.rate), z.extraPerKg])).toEqual([
      ['Kerala', [5000, 7000, 11_000, 22_000], 4000],
      ['Rest of South', [6000, 8500, 13_000, 26_000], 4500],
      ['Rest of India', [7000, 10_000, 15_000, 30_000], 5500],
      ['NE / J&K / islands', [10_000, 14_000, 20_000, 40_000], 7500],
    ]);
    expect(ZONES.every((z) => z.slabs.map((s) => s.maxWeightG).join() === '500,1000,2000,5000')).toBe(true);
  });

  it('aliases point to real states', () => {
    const names = new Set(STATES.map((s) => s.name));
    expect(Object.values(STATE_ALIASES).every((n) => names.has(n))).toBe(true);
  });
});

describe('parseCsv', () => {
  it.each([
    ['a,b\n1,2\n', [['a', 'b'], ['1', '2']]],
    ['a,b\r\n1,2', [['a', 'b'], ['1', '2']]],
    ['﻿a,b\n1,2', [['a', 'b'], ['1', '2']]],
    ['a\n"x, y"\n', [['a'], ['x, y']]],
    ['a\n"say ""hi"""\n', [['a'], ['say "hi"']]],
    ['a,b\n"multi\nline",2\n', [['a', 'b'], ['multi\nline', '2']]],
    ['a,b\n\n1,2\n\n', [['a', 'b'], ['1', '2']]],
    ['a,b\n1,\n', [['a', 'b'], ['1', '']]],
    ['', []],
  ])('%j', (text, rows) => { expect(parseCsv(text)).toEqual(rows); });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a\n"open')).toThrow(SeedError);
  });
});

describe('state names and text from the directory', () => {
  it.each([
    ['KERALA', 'Kerala'], ['Tamil Nadu', 'Tamil Nadu'], ['JAMMU & KASHMIR', 'Jammu and Kashmir'], ['JAMMU AND KASHMIR', 'Jammu and Kashmir'],
    ['THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU', 'Dadra and Nagar Haveli and Daman and Diu'], ['DAMAN & DIU', 'Dadra and Nagar Haveli and Daman and Diu'],
    ['ORISSA', 'Odisha'], ['PONDICHERRY', 'Puducherry'], ['CHATTISGARH', 'Chhattisgarh'], ['NCT OF DELHI', 'Delhi'],
    ['ANDAMAN & NICOBAR ISLANDS', 'Andaman and Nicobar Islands'], [' ladakh ', 'Ladakh'],
  ])('%j → %s', (raw, name) => { expect(canonicalStateName(raw)).toBe(name); });

  it.each(['', 'ATLANTIS', 'KERALAM'])('unknown %j → null', (raw) => { expect(canonicalStateName(raw)).toBeNull(); });

  it.each([['ERNAKULAM H.O', 'Ernakulam H.O'], ['  new   delhi g.p.o. ', 'New Delhi G.P.O.'], ['KOCHI (ERNAKULAM)', 'Kochi (Ernakulam)']])('tidy %j → %j', (raw, out) => {
    expect(tidy(raw)).toBe(out);
  });
});

describe('parseDirectory', () => {
  const H = 'circlename,officename,pincode,district,statename';
  it('maps rows, dedupes (last wins) and reports skipped rows with line numbers', () => {
    const d = parseDirectory([H,
      'K,ERNAKULAM H.O,682011,ERNAKULAM,KERALA',
      'K,ERNAKULAM H.O,682011,KOCHI,KERALA',            // duplicate key ⇒ last wins
      'K,BAD PIN,02011,X,KERALA',
      'K,NOWHERE,682012,X,ATLANTIS',
      'K,,682013,X,KERALA',
      'K,NO DISTRICT,682014,,KERALA',
      `K,${'A'.repeat(121)},682015,X,KERALA`,
    ].join('\n'));
    expect(d.rows).toEqual([{ pincode: '682011', officeName: 'Ernakulam H.O', district: 'Kochi', stateName: 'Kerala' }]);
    expect(d.skipped).toEqual([
      { line: 4, reason: 'invalid pincode "02011"' },
      { line: 5, reason: 'unknown state "ATLANTIS"' },
      { line: 6, reason: 'missing or over-long office name' },
      { line: 7, reason: 'missing or over-long district' },
      { line: 8, reason: 'missing or over-long office name' },
    ]);
  });
  it('header matching is case-insensitive; a missing column or an empty file is an error', () => {
    expect(parseDirectory('OfficeName,PinCode,District,StateName\nX,682011,Y,KERALA').rows).toHaveLength(1);
    expect(() => parseDirectory('officename,pincode,district\nX,682011,Y')).toThrow(/no "statename" column/);
    expect(() => parseDirectory('')).toThrow(/empty/);
  });
});

describe('CLI input', () => {
  it('parseArgs', () => {
    expect(parseArgs([])).toEqual({ postalFile: null });
    expect(parseArgs(['--postal-codes', 'x.csv'])).toEqual({ postalFile: 'x.csv' });
    expect(() => parseArgs(['--postal-codes'])).toThrow(/needs a file path/);
    expect(() => parseArgs(['--postal-codes', '--other'])).toThrow(/needs a file path/);
    expect(() => parseArgs(['--password', 'x'])).toThrow(/unknown argument --password/);
  });
  it('adminFromEnv needs both email and password, or neither', () => {
    expect(adminFromEnv({})).toBeNull();
    expect(adminFromEnv({ SEED_ADMIN_EMAIL: 'a@x.in', SEED_ADMIN_PASSWORD: 'p' })).toEqual({ email: 'a@x.in', password: 'p' });
    expect(adminFromEnv({ SEED_ADMIN_EMAIL: 'a@x.in', SEED_ADMIN_PASSWORD: 'p', SEED_ADMIN_NAME: 'Owner' })).toMatchObject({ name: 'Owner' });
    expect(() => adminFromEnv({ SEED_ADMIN_EMAIL: 'a@x.in' })).toThrow(/both/);
    expect(() => adminFromEnv({ SEED_ADMIN_PASSWORD: 'p' })).toThrow(/both/);
  });
  it('formatReport lists every step', () => {
    const out = formatReport({ shipping: { created: 4, updated: 0, unchanged: 0, notes: [] }, geo: 'skipped', settings: 'skipped', postalCodes: 'skipped', admin: { created: 1, updated: 0, unchanged: 0, notes: ['n'] } });
    expect(out).toContain('shipping     created 4, updated 0, unchanged 0');
    expect(out).toContain('postalCodes  skipped');
    expect(out).toMatch(/admin {8}created 1.*\n {13}n/);
  });
});

describe('password hashing', () => {
  it('argon2id with the documented parameters; verifies only the right password', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(await hashPassword('correct horse battery')).not.toBe(h);    // salted
  });
});
