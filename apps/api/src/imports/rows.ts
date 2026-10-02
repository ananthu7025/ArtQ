// Catalogue import rows (database.md §9). A layout adapter (template.ts or sheet1-profile.ts) turns spreadsheet rows into
// `DraftRow`s; `finalizeRows` then applies the rules every import follows:
//   sizes normalised (unit missing ⇒ SIZE_CONFLICT) · prices to paise (missing ⇒ PRICE_MISSING; MRP below price dropped)
//   · stock text never guessed (⇒ 0, STOCK_AMBIGUOUS, uncounted) · identical descriptions across products
//   ⇒ DESCRIPTION_SUSPECT_COPY · missing weight ⇒ category estimate, ESTIMATED + WEIGHT_ESTIMATED · "NA" ⇒ empty ·
//   SKUs generated when blank and unique in the file · product fields come from the product's first row.
// No flagged value is silently turned into sellable data.
import { normaliseSize, slugify, type NetUnit } from '@artq/shared';

export type Message = { code: string; text: string };

/** One spreadsheet row, as a layout adapter understands it (values still as written, except cleanups it applied). */
export type DraftRow = {
  rowNumber: number;
  productKey: string;            // products.import_key
  typeName: string | null;
  categoryName: string | null;
  product: {
    name: string; description: string | null; details: string[]; care: string[]; howToUse?: string | null;
    techniques: string[]; images: string[]; metaTitle: string | null; metaDescription: string | null;
    isTrending: boolean | null; isNewArrival: boolean | null; flags: string[];
  };
  variant: {
    sku: string | null; size: string | null; color: string | null; thickness: string | null; imageUrl: string | null;
    price: unknown; mrp: unknown; stock: unknown; weightKg: unknown; flags: string[];
  };
  /** Weight estimate when the sheet has none (planning figures, catalog.md §4), in grams. */
  estimateWeightG?: (size: { netQuantity: number | null; netUnit: NetUnit | null; label: string | null }) => number | null;
  /** Products of one family may share a description without being flagged as copied (e.g. the teak frames). */
  descriptionFamily?: string;
  /** SKU parts when one must be generated. */
  skuParts?: { type: string; category: string };
  messages: Message[];
};

/** A row ready to apply: typed values, flags and messages. Stored as product_import_rows.payload. */
export type CatalogRow = {
  rowNumber: number;
  productKey: string;
  lead: boolean;                 // the product's first row: its product fields are the ones applied
  typeName: string | null;
  categoryName: string | null;
  product: {
    name: string; slug: string; description: string | null; details: string[]; care: string[]; howToUse: string | null;
    techniques: string[]; images: string[]; metaTitle: string | null; metaDescription: string | null;
    isTrending: boolean | null; isNewArrival: boolean | null; flags: string[];
  };
  variant: {
    sku: string; size: string | null; netQuantity: number | null; netUnit: NetUnit | null; color: string | null; thickness: string | null;
    imageUrl: string | null; price: number | null; mrp: number | null; stock: number; stockCounted: false;
    /** The stock cell as written when it was not a count (shown again in the result file). */
    stockText: string | null;
    weightG: number | null; weightSource: 'MEASURED' | 'ESTIMATED' | null; flags: string[];
  };
  messages: Message[];
};

const NA = /^(n\/?a|na|-|none|nil)$/i;
export const clean = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' || NA.test(s) ? null : s;
};
export const list = (v: unknown): string[] => (clean(v) ?? '').split('|').map((x) => x.trim()).filter(Boolean);
export const bool = (v: unknown): boolean | null => {
  const s = clean(v)?.toLowerCase();
  return s === 'true' || s === 'yes' || s === '1' ? true : s === 'false' || s === 'no' || s === '0' ? false : null;
};

/** "₹1,499", 1499, "1499.5" → paise; anything else → null. */
export function paise(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
  const s = clean(v)?.replace(/^₹\s?/, '').replace(/,/g, '');
  if (!s || !/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Math.round(Number(s) * 100);
  return n > 0 ? n : null;
}

/** A whole non-negative number of units, or null when the cell is text, blank or fractional. */
export function stockUnits(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  const s = clean(v);
  return s !== null && /^\d+$/.test(s) ? Number(s) : null;
}

/** Upper-case SKU code of a value: "1.5 kg" → "1.5KG", "12X16 Double Frame" → "12X16DOUBLEFRAME". */
export const code = (v: string) => v.toUpperCase().replace(/[^A-Z0-9.]+/g, '');

const add = (list: string[], f: string) => { if (!list.includes(f)) list.push(f); };

export function finalizeRows(drafts: DraftRow[]): CatalogRow[] {
  const seenProducts = new Set<string>();
  const skus = new Set<string>();
  const descriptionOwner = new Map<string, { key: string; family: string | undefined }>();
  const out: CatalogRow[] = [];
  for (const d of drafts) {
    const messages = [...d.messages];
    const productKey = slugify(d.productKey, 120) || `row-${d.rowNumber}`;
    const lead = !seenProducts.has(productKey);
    seenProducts.add(productKey);
    const productFlags = [...d.product.flags];
    const variantFlags = [...d.variant.flags];

    // Size
    const rawSize = clean(d.variant.size);
    let size: string | null = rawSize, netQuantity: number | null = null, netUnit: NetUnit | null = null;
    if (rawSize) {
      const n = normaliseSize(rawSize);
      if (n.ok) { size = n.label; netQuantity = n.netQuantity; netUnit = n.netUnit; }
      else if (n.reason === 'UNIT_MISSING') { add(variantFlags, 'SIZE_CONFLICT'); messages.push({ code: 'SIZE_CONFLICT', text: `Size “${rawSize}” has no unit; confirm it (e.g. 10 gm)` }); }
      else messages.push({ code: 'SIZE_UNPARSED', text: `Size “${rawSize}” kept as written (no net quantity)` });
    }

    // Prices
    const price = paise(d.variant.price);
    let mrp = paise(d.variant.mrp);
    if (price === null) { add(variantFlags, 'PRICE_MISSING'); messages.push({ code: 'PRICE_MISSING', text: clean(d.variant.price) ? `Price “${clean(d.variant.price)}” is not a number` : 'No selling price' }); }
    if (mrp !== null && price !== null && mrp < price) {
      messages.push({ code: 'MRP_BELOW_PRICE', text: `MRP ₹${mrp / 100} is below the price ₹${price / 100}; MRP not imported` });
      add(variantFlags, 'PRICE_REVIEW');
      mrp = null;
    }

    // Stock: never guessed
    const units = stockUnits(d.variant.stock);
    if (units === null) {
      add(variantFlags, 'STOCK_AMBIGUOUS');
      messages.push({ code: 'STOCK_AMBIGUOUS', text: clean(d.variant.stock) ? `Stock “${clean(d.variant.stock)}” is not a count: imported as 0, to be counted` : 'No stock count: imported as 0, to be counted' });
    }

    // Weight
    let weightG: number | null = null, weightSource: 'MEASURED' | 'ESTIMATED' | null = null;
    const kg = typeof d.variant.weightKg === 'number' ? d.variant.weightKg : Number(clean(d.variant.weightKg));
    if (Number.isFinite(kg) && kg > 0 && clean(d.variant.weightKg) !== null) { weightG = Math.round(kg * 1000); weightSource = 'MEASURED'; }
    else {
      const est = d.estimateWeightG?.({ netQuantity, netUnit, label: size }) ?? null;
      if (est) { weightG = est; weightSource = 'ESTIMATED'; add(variantFlags, 'WEIGHT_ESTIMATED'); }
    }

    // SKU: as given (upper-cased) or generated; unique within the file
    let sku = clean(d.variant.sku)?.toUpperCase().replace(/\s+/g, '-') ?? null;
    if (!sku) {
      const parts = d.skuParts ?? { type: code(d.typeName ?? 'GEN').slice(0, 3), category: code(d.categoryName ?? '').slice(0, 4) };
      const option = [rawSize, clean(d.variant.color), clean(d.variant.thickness)].filter(Boolean).map((x) => code(x!)).join('-') || 'STD';
      sku = [parts.type, parts.category, option].filter(Boolean).join('-').slice(0, 60);
      messages.push({ code: 'SKU_GENERATED', text: `SKU ${sku} generated (kept in the result file)` });
    }
    if (skus.has(sku)) {
      let n = 2;
      while (skus.has(`${sku}-${n}`)) n++;
      messages.push({ code: 'SKU_DUPLICATE', text: `SKU ${sku} is used by an earlier row; this row uses ${sku}-${n}` });
      sku = `${sku}-${n}`;
    }
    skus.add(sku);

    // Copied descriptions: identical text on two different products
    const desc = clean(d.product.description);
    if (lead && desc) {
      const k = desc.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const owner = descriptionOwner.get(k);
      if (owner && owner.key !== productKey && (owner.family === undefined || owner.family !== d.descriptionFamily)) {
        add(productFlags, 'DESCRIPTION_SUSPECT_COPY');
        messages.push({ code: 'DESCRIPTION_SUSPECT_COPY', text: 'The description is identical to another product’s; review it' });
      } else if (!owner) descriptionOwner.set(k, { key: productKey, family: d.descriptionFamily });
    }

    out.push({
      rowNumber: d.rowNumber, productKey, lead, typeName: clean(d.typeName), categoryName: clean(d.categoryName),
      product: {
        name: clean(d.product.name) ?? productKey, slug: productKey, description: desc, details: d.product.details, care: d.product.care,
        howToUse: clean(d.product.howToUse ?? null), techniques: d.product.techniques, images: d.product.images,
        metaTitle: clean(d.product.metaTitle)?.slice(0, 160) ?? null, metaDescription: clean(d.product.metaDescription)?.slice(0, 320) ?? null,
        isTrending: d.product.isTrending, isNewArrival: d.product.isNewArrival, flags: productFlags,
      },
      variant: {
        sku, size, netQuantity, netUnit, color: clean(d.variant.color)?.slice(0, 60) ?? null, thickness: clean(d.variant.thickness)?.slice(0, 40) ?? null,
        imageUrl: clean(d.variant.imageUrl), price, mrp, stock: units ?? 0, stockCounted: false, stockText: units === null ? clean(d.variant.stock) : null, weightG, weightSource, flags: variantFlags,
      },
      messages,
    });
  }
  return out;
}
