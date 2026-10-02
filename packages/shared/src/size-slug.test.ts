import { describe, expect, it } from 'vitest';
import { normaliseSize } from './size.js';
import { slugify, uniqueSlug } from './slug.js';

describe('normaliseSize (catalog.md examples)', () => {
  it.each([
    ['500GM', '500 gm', 500, 'G'],
    ['20gm', '20 gm', 20, 'G'],
    ['300 gm', '300 gm', 300, 'G'],
    ['750 GMS', '750 gm', 750, 'G'],
    ['1.5 kg', '1.5 kg', 1.5, 'KG'],
    ['1.50KG', '1.5 kg', 1.5, 'KG'],
    ['500 ml', '500 ml', 500, 'ML'],
    ['1 L', '1 L', 1000, 'ML'],
    ['6Inch', '6 in', 6, 'IN'],
    ['8 inch', '8 in', 8, 'IN'],
    ['10"', '10 in', 10, 'IN'],
    ['1 unit', '1 unit', 1, 'PCS'],
    ['3 pcs', '3 units', 3, 'PCS'],
  ] as const)('%s → %s', (raw, label, netQuantity, netUnit) => {
    expect(normaliseSize(raw)).toEqual({ ok: true, label, netQuantity, netUnit, dimensions: null, extra: null });
  });

  it.each([
    ['4X6', '4×6 in', 4, 6, null],
    ['12 x 16', '12×16 in', 12, 16, null],
    ['10x13.5 inch', '10×13.5 in', 10, 13.5, null],
    ['12×16 in', '12×16 in', 12, 16, null],
    ['12X16 Double Frame', '12×16 in', 12, 16, 'Double Frame'],
    ['4x6 inches', '4×6 in', 4, 6, null],
  ])('frame size %s → %s', (raw, label, width, height, extra) => {
    expect(normaliseSize(raw)).toEqual({ ok: true, label, netQuantity: 1, netUnit: 'PCS', dimensions: { width, height }, extra });
  });

  it('keeps a descriptor after a single size', () => {
    expect(normaliseSize('8 Inch Hexagon')).toMatchObject({ ok: true, label: '8 in', extra: 'Hexagon' });
  });

  it.each([
    ['10', 'UNIT_MISSING'],          // mica: "10" with no unit ⇒ SIZE_CONFLICT on import, never guessed
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['Stock Out', 'UNPARSEABLE'],
    ['500KGG', 'UNPARSEABLE'],
    ['10 furlongs', 'UNPARSEABLE'],
    ['0 gm', 'INVALID_QUANTITY'],
    ['0x6', 'INVALID_QUANTITY'],
    ['1.5 pcs', 'INVALID_QUANTITY'],
    ['10 (approx)', 'UNPARSEABLE'],
  ])('%j → %s', (raw, reason) => {
    expect(normaliseSize(raw)).toEqual({ ok: false, reason, input: raw });
  });
});

describe('slugify', () => {
  it.each([
    ['Table Tops & Coasters', 'table-tops-coasters'],
    ['2:1 Epoxy Resin', '2-1-epoxy-resin'],
    ['Metallic White Gel Pigment', 'metallic-white-gel-pigment'],
    ['  --Teak Wood Frame--  ', 'teak-wood-frame'],
    ['Crème Brûlée Mica', 'creme-brulee-mica'],
    ['Pregnant Mom Frame (11×6)', 'pregnant-mom-frame-11-6'],
    ['ÀÉÎÕÜ', 'aeiou'],
    ['!!!', ''],
  ])('%j → %j', (input, slug) => { expect(slugify(input)).toBe(slug); });

  it('truncates at a word boundary, or hard-cuts a single long word', () => {
    expect(slugify('alpha beta gamma', 12)).toBe('alpha-beta');
    expect(slugify('abcdefghij', 4)).toBe('abcd');
    expect(() => slugify('x', 0)).toThrow(/maxLength/);
  });
});

describe('uniqueSlug', () => {
  it('returns the base when free, else the first free numbered suffix', () => {
    const taken = new Set(['cloud-frame', 'cloud-frame-2']);
    expect(uniqueSlug('Butterfly Frame', (s) => taken.has(s))).toBe('butterfly-frame');
    expect(uniqueSlug('Cloud Frame', (s) => taken.has(s))).toBe('cloud-frame-3');
  });
  it('keeps the suffix within the length limit', () => {
    const s = uniqueSlug('alpha beta gamma', (x) => x === 'alpha-beta', 12);
    expect(s).toBe('alpha-beta-2');
    expect(s.length).toBeLessThanOrEqual(12);
  });
  it('rejects input that yields no slug', () => {
    expect(() => uniqueSlug('***', () => false)).toThrow(/cannot derive/);
  });
});
