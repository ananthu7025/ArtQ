// The client's "Sheet1" layout → import rows, with the cleanup catalog.md specifies (§1 structure, §2 names/SKUs/
// techniques, §4 issues, §6 review flags). This file is that document as data: the generic rules (rows.ts) do the rest.
//
//   • Blank Type / Subcategory / Product Name / Description cells are forward-filled; a row whose product name is blank
//     but whose subcategory changed is a new product named after the subcategory (the Resin Art Essentials rows).
//   • Teak frames: the sheet's two depth groups become three products (Frame, Double Frame, Hexagon Frame) with depth as
//     the thickness option (catalog.md §2.2).
//   • Spelling: Metalic→Metallic, Emarald→Emerald, Mahagani/Mahagony→Mahogany, Elcstro Plated→Electroplated.
import type { NetUnit } from '@artq/shared';
import type { Cell, RawRow } from './workbook.js';
import { clean, list, type DraftRow } from './rows.js';

/** catalog.md §1: types (slug, home order) and their categories (slug). */
export const CATALOG_STRUCTURE: { type: string; slug: string; categories: { name: string; slug: string }[] }[] = [
  { type: 'Resins', slug: 'resins', categories: [{ name: '2:1 Epoxy Resin', slug: '2-1-epoxy-resin' }, { name: '3:1 Epoxy Resin', slug: '3-1-epoxy-resin' }, { name: 'UV Resin', slug: 'uv-resin' }] },
  { type: 'Wooden Frames', slug: 'wooden-frames', categories: [{ name: 'Teakwood Frames', slug: 'teakwood-frames' }, { name: 'Round Mahogany Frames', slug: 'round-mahogany-frames' }] },
  { type: 'Multiwood Frames', slug: 'multiwood-frames', categories: [{ name: 'Pregnant Mom Frames', slug: 'pregnant-mom-frames' }, { name: 'Butterfly Frames', slug: 'butterfly-frames' }, { name: 'Cloud Frames', slug: 'cloud-frames' }, { name: 'Couple Frames', slug: 'couple-frames' }] },
  { type: 'Hoops', slug: 'hoops', categories: [{ name: 'Round Hoops', slug: 'round-hoops' }] },
  { type: 'Pigments', slug: 'pigments', categories: [{ name: 'Gel Pigments', slug: 'gel-pigments' }, { name: 'Mica Powder Pigments', slug: 'mica-powder-pigments' }, { name: 'Pigment Kits', slug: 'pigment-kits' }] },
  { type: 'Glitters', slug: 'glitters', categories: [{ name: 'Glitters', slug: 'glitters-all' }] },
  { type: 'Silica Gel', slug: 'silica-gel', categories: [{ name: 'Silica Gel', slug: 'silica-gel-all' }] },
  { type: 'Resin Art Essentials', slug: 'resin-art-essentials', categories: [{ name: 'Tools', slug: 'resin-tools' }, { name: 'Stands', slug: 'stands' }] },
];

/** catalog.md §1 techniques (slug). */
export const TECHNIQUES: Record<string, string> = {
  'Resin Art': 'resin-art', 'Flower / Memory Preservation': 'flower-preservation', 'Photo Framing': 'photo-framing', 'Jewellery Making': 'jewellery-making',
  'Table Tops & Coasters': 'table-tops-coasters', 'Deep Pour Casting': 'deep-pour-casting', 'Home Decor': 'home-decor', 'Embroidery & Hoop Art': 'embroidery-hoop-art',
};
const FLOWER = 'Flower / Memory Preservation';

const SPELLING: [RegExp, string][] = [[/\bMetalic\b/gi, 'Metallic'], [/\bEmarald\b/gi, 'Emerald'], [/\bMahag[ao]n[iy]\b/gi, 'Mahogany'], [/\bElcstro\s*Plated\b/gi, 'Electroplated']];
const spell = (s: string | null) => (s === null ? null : SPELLING.reduce((t, [re, to]) => t.replace(re, to), s));

// ── Planning weight estimates (catalog.md §4: imported as ESTIMATED, which blocks publication) ──
type Size = { netQuantity: number | null; netUnit: NetUnit | null; label: string | null };
const dims = (label: string | null) => { const m = /(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)/i.exec(label ?? ''); return m ? Number(m[1]) * Number(m[2]) : null; };
const inches = (label: string | null) => { const m = /^(\d+(?:\.\d+)?)\s*in\b/i.exec(label ?? ''); return m ? Number(m[1]) : null; };
const W = {
  resin: (s: Size) => (s.netQuantity === null ? null : Math.round((s.netUnit === 'KG' ? s.netQuantity * 1000 : s.netUnit === 'G' ? s.netQuantity : NaN) * 1.15) || null),
  teak: (double: boolean) => (s: Size) => { const a = dims(s.label) ?? (inches(s.label) ?? 0) ** 2; return a ? Math.round((130 + 5 * a) * (double ? 1.4 : 1)) : null; },
  round: (s: Size) => { const i = inches(s.label); return i ? Math.round(250 + (i - 6) * 62.5) : null; },
  multiwood: (s: Size) => ((dims(s.label) ?? 0) > 150 ? 1000 : 600),
  fixed: (g: number) => () => g,
  kit: (s: Size) => (s.netQuantity !== null && s.netQuantity >= 200 ? 400 : 250),
  stand: (s: Size) => { const i = inches(s.label); return i ? Math.round(300 + (i - 6) * 50) : null; },
};

type Product = {
  key: string; name: string; type: string; category: string; techniques: string[]; sku: (size: string, row: Cells) => string;
  description?: string; productFlags?: string[]; variantFlags?: (size: string, row: Cells) => string[]; color?: (row: Cells) => string | null;
  size?: (raw: string) => string; detailsExtra?: (row: Cells) => string[]; weight?: (s: Size) => number | null; family?: string;
};
type Cells = Record<string, Cell>;

const sz = (raw: string) => raw.toUpperCase().replace(/\s+/g, '').replace(/(GM|GMS)$/, 'G').replace(/INCH$/, 'IN');
const by = (prefix: string) => (size: string) => `${prefix}-${sz(size)}`;
const RESIN_TECH = ['Resin Art', 'Table Tops & Coasters'];
const MULTIWOOD = 'Multiwood decorative frames in creative shapes, designed for art, craft and home decor projects.';
const multiwood = (key: string, name: string, category: string, prefix: string): Product => ({
  key, name, type: 'Multiwood Frames', category, techniques: ['Home Decor', 'Resin Art', FLOWER], sku: by(prefix), description: MULTIWOOD,
  productFlags: ['COLOUR_REVIEW'], weight: W.multiwood, family: 'multiwood',
});

/** Gel pigments (catalog.md §2.5): sheet name → cleaned name, SKU code. */
const GEL: [string, string, string][] = [
  ['Metalic White', 'Metallic White', 'MWHITE'], ['Metalic Silver', 'Metallic Silver', 'MSILVER'], ['Metalic Summer Blue', 'Metallic Summer Blue', 'MSUMBLUE'],
  ['Metalic Black', 'Metallic Black', 'MBLACK'], ['Metalic Lemon Yellow', 'Metallic Lemon Yellow', 'MLEMON'], ['Metalic Bronze', 'Metallic Bronze', 'MBRONZE'],
  ['Metalic Purple', 'Metallic Purple', 'MPURPLE'], ['Metalic Gold', 'Metallic Gold', 'MGOLD'], ['Metalic Pink', 'Metallic Pink', 'MPINK'],
  ['Metalic Mint Green', 'Metallic Mint Green', 'MMINT'], ['Metalic Red Wine', 'Metallic Red Wine', 'MREDWINE'], ['Milk White', 'Milk White', 'MILKWHITE'],
  ['Matte Orange', 'Matte Orange', 'ORANGE'], ['Pastel Red', 'Pastel Red', 'PRED'], ['Myrtle Green', 'Myrtle Green', 'MYRTLE'], ['Matte Grey', 'Matte Grey', 'GREY'],
  ['Pastel Green', 'Pastel Green', 'PGREEN'], ['Matte Yellow', 'Matte Yellow', 'YELLOW'], ['Midnight Blue', 'Midnight Blue', 'MIDNIGHT'],
  ['Antique Brown', 'Antique Brown', 'ABROWN'], ['Sandstone', 'Sandstone', 'SANDSTONE'], ['Aqua Marine', 'Aquamarine', 'AQUA'], ['Emarald Green', 'Emerald Green', 'EMERALD'],
  ['Pastel Pink', 'Pastel Pink', 'PPINK'], ['Ultra Marine Blue', 'Ultramarine Blue', 'ULTRAMARINE'], ['Ivory', 'Ivory', 'IVORY'], ['Olive Green', 'Olive Green', 'OLIVE'],
  ['Windsor Navy Blue', 'Windsor Navy Blue', 'NAVY'], ['Pure Red', 'Pure Red', 'RED'],
];
/** Mica powders (catalog.md §2.5): sheet name → colour, SKU code. */
const MICA: [string, string, string][] = [
  ['Mica Silver', 'Silver', 'SILVER'], ['Pearl White', 'Pearl White', 'PWHITE'], ['Pearl Gold', 'Pearl Gold', 'PGOLD'], ['Pearl Maroon', 'Pearl Maroon', 'PMAROON'],
  ['Pearl Pink', 'Pearl Pink', 'PPINK'], ['Pearl Summer Blue', 'Pearl Summer Blue', 'PSUMBLUE'], ['Pearl Lemon Yellow', 'Pearl Lemon Yellow', 'PLEMON'],
  ['Pearl Bronze', 'Pearl Bronze', 'PBRONZE'], ['Pearl Parrot Green', 'Pearl Parrot Green', 'PPARROT'], ['Pearl Orange', 'Pearl Orange', 'PORANGE'],
  ['Pearl Navy Blue', 'Pearl Navy Blue', 'PNAVY'], ['Pearl Grey', 'Pearl Grey', 'PGREY'],
];

const teakDepth = (row: Cells) => (/0\.5\s*inch/i.test(String(row.subcategory ?? '')) ? '0.5 inch' : '1 inch');
const teakSize = (raw: string) => raw.replace(/\s*double\s*frame/i, '').replace(/\s*hexagon/i, '').trim();
const teak = (kind: 'frame' | 'double' | 'hex'): Product => ({
  key: { frame: 'teak-wood-frame', double: 'teak-wood-double-frame', hex: 'teak-wood-hexagon-frame' }[kind],
  name: { frame: 'Teak Wood Frame with Plywood Base', double: 'Teak Wood Double Frame (Plywood Base)', hex: 'Teak Wood Hexagon Frame' }[kind],
  type: 'Wooden Frames', category: 'Teakwood Frames', techniques: ['Photo Framing', 'Resin Art', FLOWER], size: teakSize,
  sku: (size, row) => `TWF-${teakDepth(row) === '0.5 inch' ? '05IN' : '1IN'}-${kind === 'hex' ? `HEX${parseInt(size, 10)}` : sz(size)}${kind === 'double' ? '-DF' : ''}`,
  // catalog.md §4 #6: 0.5" 8×10 costs more than 10×10; 0.5" 9×12 double costs more than the 1" one.
  variantFlags: (size, row) => (teakDepth(row) === '0.5 inch' && ((kind === 'frame' && sz(size) === '8X10') || (kind === 'double' && sz(size) === '9X12')) ? ['PRICE_REVIEW'] : []),
  weight: W.teak(kind === 'double'), family: 'teak',
});

/** Sheet product name (after forward fill and spelling) → cleaned product. */
function productFor(name: string, row: Cells): Product | null {
  const size = String(row['size / volume'] ?? '');
  if (/^teak wood frames with plywood base/i.test(name)) return teak(/double/i.test(size) ? 'double' : /hexagon/i.test(size) ? 'hex' : 'frame');
  const gel = GEL.find(([sheet]) => spell(sheet) === name);
  if (gel && /gel/i.test(String(row.subcategory ?? ''))) {
    return { key: `${gel[1]} gel pigment`, name: `${gel[1]} Gel Pigment`, type: 'Pigments', category: 'Gel Pigments', techniques: RESIN_TECH, sku: () => `PIG-GEL-${gel[2]}`, weight: W.fixed(50) };
  }
  const mica = MICA.find(([sheet]) => sheet === name);
  if (mica && /powder/i.test(String(row.subcategory ?? ''))) {
    // catalog.md §4 #10: sizes "10" without a unit while the details say 20 gm.
    return { key: `mica powder ${mica[1]}`, name: `Mica Powder: ${mica[1]}`, type: 'Pigments', category: 'Mica Powder Pigments', techniques: ['Resin Art', 'Jewellery Making'], sku: () => `PIG-MICA-${mica[2]}`, variantFlags: () => ['SIZE_CONFLICT'], weight: W.fixed(30) };
  }
  const kit = (key: string, kname: string, skuCode: string): Product => ({
    key, name: kname, type: 'Pigments', category: 'Pigment Kits', techniques: RESIN_TECH, sku: () => `PIG-KIT-${skuCode}`, productFlags: ['COLOUR_REVIEW'],
    color: () => null, detailsExtra: (r) => (clean(r.color) ? [`Colours included: ${clean(r.color)!.replace(/,\s*$/, '')}`] : []), weight: W.kit,
  });
  const table: Record<string, () => Product> = {
    '2:1 Epoxy Resin': () => ({ key: '2-1-epoxy-resin', name: 'ArtQ Ultra Clear 2:1 Epoxy Resin', type: 'Resins', category: '2:1 Epoxy Resin', techniques: [...RESIN_TECH, 'Deep Pour Casting', FLOWER], sku: by('RES-21'), weight: W.resin }),
    '3:1 Epoxy Resin': () => ({ key: '3-1-epoxy-resin', name: 'ArtQ 3:1 Epoxy Resin', type: 'Resins', category: '3:1 Epoxy Resin', techniques: RESIN_TECH, sku: by('RES-31'), weight: W.resin }),
    // catalog.md §4 #6: UV Resin 50 gm ₹180 vs ₹170 (sheet 2) vs ₹250 (reference site).
    'UV Resin': () => ({ key: 'uv-resin', name: 'ArtQ UV Resin', type: 'Resins', category: 'UV Resin', techniques: ['Jewellery Making', 'Resin Art'], sku: by('RES-UV'), variantFlags: (s) => (sz(s) === '50G' ? ['PRICE_CONFLICT'] : []), weight: W.resin }),
    // catalog.md §4 #13: meta title says "Plywood Base" for an acrylic-base frame.
    'Mahogany Frames with Acrylic Base': () => ({ key: 'round-mahogany-frame', name: 'Round Mahogany Frame with Acrylic Base', type: 'Wooden Frames', category: 'Round Mahogany Frames', techniques: ['Photo Framing', 'Resin Art'], sku: (s) => `MHF-RND-${sz(s)}`, productFlags: ['COPY_REVIEW'], weight: W.round }),
    'Pregnant Mom Frame': () => multiwood('pregnant-mom-frame', 'Pregnant Mom Frame', 'Pregnant Mom Frames', 'MW-MOM'),
    'Butterfly Frame': () => multiwood('butterfly-frame', 'Butterfly Frame', 'Butterfly Frames', 'MW-BFLY'),
    'Cloud Frame': () => multiwood('cloud-frame', 'Cloud Frame', 'Cloud Frames', 'MW-CLOUD'),
    'Couple Frame': () => multiwood('couple-frame', 'Couple Frame', 'Couple Frames', 'MW-COUPLE'),
    // catalog.md §4 #13: description says "embroidery hoop" for a hoop with acrylic base.
    'Hoops with Acrylic base': () => ({ key: 'hoop-with-acrylic-base', name: 'Hoop with Acrylic Base', type: 'Hoops', category: 'Round Hoops', techniques: ['Embroidery & Hoop Art', 'Resin Art', 'Home Decor'], sku: (s) => `HOOP-ACR-${sz(s)}`, productFlags: ['COPY_REVIEW'], weight: W.round }),
    'Beach pigments': () => kit('ocean-theme-pigment-kit', 'Ocean Theme Pigment Kit', 'OCEAN'),
    'Pack of 5 basic pigments': () => kit('basic-pigments-pack-of-5', 'Basic Pigments: Pack of 5', 'BASIC5'),
    'Pack of 10 basic pigments': () => kit('basic-pigments-pack-of-10', 'Basic Pigments: Pack of 10', 'BASIC10'),
    // catalog.md §4 #16: "9 Colours" may mean a set of 9 or 9 single-colour variants.
    'Rainbow Chunks': () => ({ key: 'rainbow-chunky-glitter', name: 'Rainbow Chunky Glitter', type: 'Glitters', category: 'Glitters', techniques: ['Resin Art', 'Jewellery Making'], sku: () => 'GLT-RAINBOW-CHUNK', size: () => 'Set of 9 colours', productFlags: ['COLOUR_REVIEW'], weight: W.fixed(150) }),
    'Rainbow Star Glitter': () => ({ key: 'rainbow-neon-star-glitter', name: 'Rainbow Neon Star Glitter', type: 'Glitters', category: 'Glitters', techniques: ['Resin Art', 'Jewellery Making'], sku: () => 'GLT-RAINBOW-STAR', size: () => 'Set of 9 colours', productFlags: ['COLOUR_REVIEW'], weight: W.fixed(150) }),
    'Magic Silica Gel': () => ({ key: 'magic-silica-gel-500gm', name: 'Magic Silica Gel 500 gm', type: 'Silica Gel', category: 'Silica Gel', techniques: [FLOWER], sku: () => 'SG-MAGIC-500G', weight: W.fixed(550) }),
    'UV Light': () => ({ key: 'uv-curing-light', name: 'UV Curing Light', type: 'Resin Art Essentials', category: 'Tools', techniques: ['Resin Art', 'Jewellery Making'], sku: () => 'ESS-UV-LIGHT', weight: W.fixed(100) }),
    // catalog.md §4 #5: description, size and price copied from UV Resin.
    'Bubble Buster': () => ({ key: 'bubble-buster', name: 'Bubble Buster', type: 'Resin Art Essentials', category: 'Tools', techniques: ['Resin Art'], sku: () => 'ESS-BUBBLE-50G', productFlags: ['DESCRIPTION_SUSPECT_COPY'], variantFlags: () => ['SIZE_CONFLICT'] }),
    'Deco Marker': () => ({ key: 'deco-marker', name: 'Deco Marker', type: 'Resin Art Essentials', category: 'Tools', techniques: ['Resin Art'], sku: () => 'ESS-DECO-MARKER', productFlags: ['DESCRIPTION_SUSPECT_COPY'], variantFlags: () => ['SIZE_CONFLICT'] }),
    'Blow Torch': () => ({ key: 'blow-torch', name: 'Blow Torch', type: 'Resin Art Essentials', category: 'Tools', techniques: ['Resin Art'], sku: () => 'ESS-BLOW-TORCH', weight: W.fixed(400) }),
    'Folding Electroplated Metal Stand': () => ({ key: 'folding-electroplated-metal-stand', name: 'Folding Electroplated Metal Stand', type: 'Resin Art Essentials', category: 'Stands', techniques: ['Resin Art'], sku: (s) => `ESS-STAND-${sz(s)}`, weight: W.stand }),
  };
  return table[name]?.() ?? null;
}

/** Sheet1 rows → draft rows. Unknown products fall back to the generic rules (named as written, SKU generated). */
export function sheet1Drafts(rows: RawRow[]): DraftRow[] {
  const out: DraftRow[] = [];
  let prev: { type: string | null; sub: string | null; name: string | null; description: string | null; details: string | null; care: string | null; metaTitle: string | null; metaDescription: string | null } =
    { type: null, sub: null, name: null, description: null, details: null, care: null, metaTitle: null, metaDescription: null };
  for (const r of rows) {
    const c = r.cells;
    const type = clean(c.category) ?? prev.type;
    const subRaw = clean(c.subcategory);
    const sub = subRaw ?? prev.sub;
    // A blank product name continues the previous product, unless the subcategory changed (then the subcategory names it).
    const ownName = clean(c['product name']);
    const name = spell(ownName ?? (subRaw && subRaw !== prev.sub ? subRaw : prev.name)) ?? 'Unnamed product';
    const sameProduct = name === prev.name;
    const fill = (v: Cell | undefined, before: string | null) => clean(v) ?? (sameProduct ? before : null);
    const description = fill(c.description, prev.description);
    const details = fill(c['product details'], prev.details);
    const care = fill(c['specifications & care'], prev.care);
    const metaTitle = fill(c['meta title'], prev.metaTitle);
    const metaDescription = fill(c['meta description'], prev.metaDescription);
    prev = { type, sub, name, description, details, care, metaTitle, metaDescription };

    const cells: Cells = { ...c, subcategory: sub };
    const p = productFor(name, cells);
    const rawSize = clean(c['size / volume']) ?? '';
    const size = p?.size ? p.size(rawSize) : rawSize;
    // Product details lose a first line that only repeats the sheet's product name (e.g. "2:1 Epoxy Resin | …").
    const detailItems = list(spell(details)).filter((d, i) => !(i === 0 && d.toLowerCase() === (ownName ?? name).toLowerCase()));
    out.push({
      rowNumber: r.rowNumber,
      productKey: p?.key ?? name.toLowerCase(),
      typeName: p?.type ?? type, categoryName: p?.category ?? sub,
      product: {
        name: p?.name ?? name, description: spell(description) ?? p?.description ?? null,
        details: [...detailItems, ...(p?.detailsExtra?.(cells) ?? [])], care: list(spell(care)), techniques: p?.techniques ?? [], images: [],
        metaTitle: spell(metaTitle), metaDescription: spell(metaDescription), isTrending: null, isNewArrival: null, flags: p?.productFlags ?? [],
      },
      variant: {
        sku: p && size ? p.sku(size, cells) : p && !size ? p.sku('', cells) : null,
        size: size || null, color: p?.color ? p.color(cells) : spell(clean(c.color)), thickness: /^teak-wood/.test(p?.key ?? '') ? teakDepth(cells) : null, imageUrl: null,
        price: c['selling price'], mrp: c['mrp / orig price'], stock: c['stock quantity'], weightKg: null, flags: p?.variantFlags?.(size, cells) ?? [],
      },
      ...(p?.weight ? { estimateWeightG: p.weight } : {}),
      ...(p?.family ? { descriptionFamily: p.family } : {}),
      messages: p ? [] : [{ code: 'UNMAPPED_PRODUCT', text: `“${name}” is not in the catalogue mapping; imported with the generic rules` }],
    });
  }
  return out;
}

/** Planning weight estimate for a category (template imports with no Parcel Weight), catalog.md §4. */
export function estimateFor(categoryName: string | null, productName: string): ((s: Size) => number | null) | undefined {
  const c = (categoryName ?? '').toLowerCase();
  if (/epoxy resin|uv resin/.test(c)) return W.resin;
  if (/teak/.test(c)) return W.teak(/double/i.test(productName));
  if (/mahogany|hoop/.test(c)) return W.round;
  if (/pregnant|butterfly|cloud|couple|multiwood/.test(c)) return W.multiwood;
  if (/gel pigment/.test(c)) return W.fixed(50);
  if (/mica/.test(c)) return W.fixed(30);
  if (/kit/.test(c)) return W.kit;
  if (/glitter/.test(c)) return W.fixed(150);
  if (/silica/.test(c)) return W.fixed(550);
  if (/stand/.test(c)) return W.stand;
  return undefined;
}
