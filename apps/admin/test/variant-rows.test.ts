// Variant grid row logic and the editor form schema: API shapes, API messages, generation and paste.
import { describe, expect, it } from 'vitest';
import { editorForm } from '../src/pages/products/editor/schema';
import { contentBody, emptyCells, fromVariant, generateRows, isDirty, newKey, pasteColumn, pricingRequest, skuCode, validateRow, type Row } from '../src/pages/products/editor/variant-rows';

const newRow = (cells: Partial<Row['cells']>): Row => ({ key: newKey(), id: null, version: null, cells: { ...emptyCells(), ...cells }, original: null });
const existing = () => fromVariant({
  id: 5, sku: 'TWF-1IN-4X6', label: '4×6 in / 1 inch', size: '4×6 in', netQuantity: 1, netUnit: 'PCS', color: null, colorHex: null, thickness: '1 inch',
  weightG: 300, weightSource: 'MEASURED', lengthCm: null, widthCm: null, heightCm: null, shippingClass: 'STANDARD', imageMediaId: null, barcode: null,
  sortOrder: 0, isActive: true, price: 21_000, mrp: null, costPrice: 12_000, onHand: 0, reserved: 0, available: 0, dataFlags: [], version: 3,
});

describe('generation', () => {
  it('Teak Wood Frame: 8 + 6 sizes × two depths → SKUs in the catalogue format', () => {
    const one = generateRows({ prefix: 'twf', sizes: ['4x6', '6x6', '8x8', '10x10', '9x12', '12x12', '12x16', '14x14'], kind: 'thickness', options: ['1 inch'] });
    const half = generateRows({ prefix: 'TWF', sizes: '4x6, 6x6, 8x8, 8x10, 10x10, 9x12'.split(','), kind: 'thickness', options: ['0.5 inch'] });
    expect([...one, ...half].map((r) => r.cells.sku)).toEqual([
      'TWF-1IN-4X6', 'TWF-1IN-6X6', 'TWF-1IN-8X8', 'TWF-1IN-10X10', 'TWF-1IN-9X12', 'TWF-1IN-12X12', 'TWF-1IN-12X16', 'TWF-1IN-14X14',
      'TWF-05IN-4X6', 'TWF-05IN-6X6', 'TWF-05IN-8X8', 'TWF-05IN-8X10', 'TWF-05IN-10X10', 'TWF-05IN-9X12',
    ]);
    expect(one[0]!.cells).toMatchObject({ size: '4x6', thickness: '1 inch', isActive: true });
    expect(generateRows({ prefix: 'P', sizes: ['500 gm'], kind: 'none', options: ['ignored'] }).map((r) => r.cells.sku)).toEqual(['P-500GM']);
    expect(generateRows({ prefix: 'P', sizes: ['', ' '], kind: 'color', options: ['Gold'] })).toEqual([]);
  });

  it.each([['1 inch', '1IN'], ['0.5 inch', '05IN'], ['4x6', '4X6'], ['12 × 16', '1216'], ['Gold Leaf', 'GOLDLEAF'], ['8"', '8IN']])('skuCode(%s) = %s', (v, c) => {
    expect(skuCode(v)).toBe(c);
  });
});

describe('request bodies', () => {
  it('a new row sends only filled cells (and active + shipping class); prices separately in paise', () => {
    const r = newRow({ sku: 'twf-1in-4x6', size: '4x6', thickness: '1 inch', weightG: '300', price: '210', mrp: '' });
    expect(contentBody(r)).toEqual({ isActive: true, sku: 'twf-1in-4x6', size: '4x6', thickness: '1 inch', weightG: 300, shippingClass: 'STANDARD' });
    expect(pricingRequest(r)).toEqual({ price: 21_000, mrp: null, costPrice: null });
    expect(pricingRequest(newRow({ sku: 'X' }))).toBeNull();
  });

  it('an existing row sends only what changed; clearing a cell sends null', () => {
    const r = existing();
    expect(isDirty(r)).toBe(false);
    r.cells = { ...r.cells, color: 'Natural Teak', weightG: '' };
    expect(contentBody(r)).toEqual({ color: 'Natural Teak', weightG: null });
    expect(pricingRequest(r)).toBeNull();
    r.cells = { ...r.cells, price: '199.50' };
    expect(pricingRequest(r)).toEqual({ price: 19_950, mrp: null, costPrice: 12_000 });   // cost kept as shown
  });
});

describe('validation uses the API schemas and messages', () => {
  it.each([
    [{ sku: 'bad sku!' }, 'sku', 'Use letters, digits, dots, dashes and underscores'],
    [{ colorHex: 'gold' }, 'colorHex', 'Use a hex colour like #D4AF37'],
    [{ weightG: '12.5' }, 'weightG', 'Use whole grams'],
    [{ weightG: 'abc' }, 'weightG', 'Enter the weight in grams'],
    [{ lengthCm: '10.25' }, 'lengthCm', 'Use at most one decimal'],
    [{ price: '210.555' }, 'price', 'Use rupees, e.g. 210 or 210.50'],
    [{ price: '', mrp: '300' }, 'price', 'Enter a price'],
    [{ price: '300', mrp: '299' }, 'mrp', 'MRP must be at least the price'],
    [{ price: '0' }, 'price', 'The price must be more than ₹0'],
  ])('%j → %s: %s', (cells, field, message) => {
    expect(validateRow(newRow({ sku: 'OK-1', ...cells }), true)[field as 'sku']).toBe(message);
  });

  it('boundaries: MRP equal to the price passes; 64-character SKU passes, 65 fails; prices are not checked without pricing:write', () => {
    expect(validateRow(newRow({ sku: 'A'.repeat(64), price: '300', mrp: '300' }), true)).toEqual({});
    expect(validateRow(newRow({ sku: 'A'.repeat(65) }), true).sku).toBe('Use at most 64 characters');
    expect(validateRow(newRow({ sku: 'OK', price: 'abc' }), false)).toEqual({});
  });
});

describe('paste a column from a spreadsheet', () => {
  it('fills downward from the cell, strips ₹ and thousands separators only from price columns; one line is a normal paste', () => {
    const rows = [newRow({}), newRow({}), newRow({})];
    const priced = pasteColumn(rows, 1, 'price', '₹1,299\n470\r\n999\n')!;
    expect(priced.map((r) => r.cells.price)).toEqual(['', '1299', '470']);
    expect(pasteColumn(rows, 0, 'color', 'Gold, matte\nSilver')!.map((r) => r.cells.color)).toEqual(['Gold, matte', 'Silver', '']);
    expect(pasteColumn(rows, 0, 'price', '210')).toBeNull();
  });
});

describe('editor form schema', () => {
  const base = {
    name: 'Teak Wood Frame', slug: 'teak-wood-frame', typeId: 1, categoryId: 2, techniqueIds: [3], shortDescription: '', description: '<p>Frames</p>',
    productDetails: 'Teak wood frame\n\n  Plywood base  ', specificationsCare: '', howToUse: '', specifications: [{ key: ' Material ', value: 'Teak ' }, { key: '', value: '' }],
    tags: 'frames, teak, ,resin', isNewArrival: false, newArrivalRank: null, isTrending: false, trendingRank: null, isFeatured: false, sortOrder: 0,
    metaTitle: '', metaDescription: '', dataFlags: [], relations: [{ productId: 9, kind: 'SIMILAR' as const, name: 'Hexagon Frame' }],
  };
  it('converts the friendly shape to the API shape', () => {
    expect(editorForm.parse(base)).toMatchObject({
      productDetails: ['Teak wood frame', 'Plywood base'], specificationsCare: [], specifications: { Material: 'Teak' }, tags: ['frames', 'teak', 'resin'],
      shortDescription: null, howToUse: null, metaTitle: null, relations: [{ productId: 9, kind: 'SIMILAR' }],
    });
  });
  it('reports the API messages on the form fields', () => {
    const r = editorForm.safeParse({ ...base, name: ' ', slug: 'Teak Frame', metaTitle: 't'.repeat(161) });
    expect(r.success).toBe(false);
    const byPath = Object.fromEntries(r.error!.issues.map((i) => [i.path.join('.'), i.message]));
    expect(byPath).toMatchObject({ name: 'Enter a product name', slug: 'Use lowercase letters, digits and single hyphens, e.g. teak-wood-frame', metaTitle: 'Use at most 160 characters' });
  });
});
