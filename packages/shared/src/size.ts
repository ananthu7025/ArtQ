// Size normalisation (catalog.md "Size normalisation"; database.md §3.3 net_quantity + net_unit).
// Display labels: `300 gm`, `1.5 kg`, `500 ml`, `8 in`, `4×6 in`, `1 unit`. Spreadsheet spellings such as `500GM`, `20gm`,
// `6Inch`, `8 inch`, `4X6` are accepted. A bare number (`10`) has no unit and is reported, never guessed (SIZE_CONFLICT).

export type NetUnit = 'G' | 'KG' | 'ML' | 'PCS' | 'IN';

export type NormalisedSize = {
  ok: true;
  label: string;
  netQuantity: number;
  netUnit: NetUnit;
  /** Width × height in inches for frame sizes (`4×6 in`). */
  dimensions: { width: number; height: number } | null;
  /** Descriptive text after the size (`12X16 Double Frame` → `Double Frame`). */
  extra: string | null;
};
export type SizeProblem = { ok: false; reason: 'EMPTY' | 'UNIT_MISSING' | 'UNPARSEABLE' | 'INVALID_QUANTITY'; input: string };

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const UNITS: { re: RegExp; unit: NetUnit; label: (q: string) => string; scale?: number }[] = [
  { re: /^(?:g|gm|gms|gr|gram|grams)$/i, unit: 'G', label: (q) => `${q} gm` },
  { re: /^(?:kg|kgs|kilo|kilos|kilogram|kilograms)$/i, unit: 'KG', label: (q) => `${q} kg` },
  { re: /^(?:ml|mls|millilitre|millilitres|milliliter|milliliters)$/i, unit: 'ML', label: (q) => `${q} ml` },
  { re: /^(?:l|ltr|ltrs|litre|litres|liter|liters)$/i, unit: 'ML', label: (q) => `${q} L`, scale: 1000 },
  { re: /^(?:in|inch|inches|")$/i, unit: 'IN', label: (q) => `${q} in` },
  { re: /^(?:pc|pcs|piece|pieces|unit|units|nos|no)$/i, unit: 'PCS', label: (q) => (q === '1' ? '1 unit' : `${q} units`) },
];

/** Canonical decimal text: "1.50" → "1.5", "020" → "20". */
const canon = (s: string) => String(Number(s));

export function normaliseSize(raw: string): NormalisedSize | SizeProblem {
  const input = raw;
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return { ok: false, reason: 'EMPTY', input };

  // Frame sizes: 4X6, 4 x 6, 12×16 in, 10x13.5 inch, optionally followed by a description.
  const dims = new RegExp(String.raw`^${NUM}\s*[x×*]\s*${NUM}\s*(?:(?:in|inch|inches|")(?![a-z]))?\s*(.*)$`, 'i').exec(s);
  if (dims) {
    const [w, h] = [canon(dims[1]!), canon(dims[2]!)];
    if (Number(w) <= 0 || Number(h) <= 0) return { ok: false, reason: 'INVALID_QUANTITY', input };
    return { ok: true, label: `${w}×${h} in`, netQuantity: 1, netUnit: 'PCS', dimensions: { width: Number(w), height: Number(h) }, extra: dims[3] || null };
  }

  const m = new RegExp(String.raw`^${NUM}\s*([a-z"]+)?\s*(.*)$`, 'i').exec(s);
  if (!m) return { ok: false, reason: 'UNPARSEABLE', input };
  const q = canon(m[1]!);
  if (Number(q) <= 0) return { ok: false, reason: 'INVALID_QUANTITY', input };
  if (!m[2]) return m[3] ? { ok: false, reason: 'UNPARSEABLE', input } : { ok: false, reason: 'UNIT_MISSING', input };
  const u = UNITS.find((x) => x.re.test(m[2]!));
  if (!u) return { ok: false, reason: 'UNPARSEABLE', input };
  const netQuantity = Number(q) * (u.scale ?? 1);
  if (u.unit === 'PCS' && !Number.isInteger(netQuantity)) return { ok: false, reason: 'INVALID_QUANTITY', input };
  return { ok: true, label: u.label(q), netQuantity, netUnit: u.unit, dimensions: null, extra: m[3] || null };
}
