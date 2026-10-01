// URL slugs (product.md: lowercase, hyphenated, unique). Examples from catalog.md:
// "Table Tops & Coasters" → table-tops-coasters, "2:1 Epoxy Resin" → 2-1-epoxy-resin.

/** Lowercase ASCII slug; diacritics stripped, every other run of non-alphanumerics becomes one hyphen. Max `maxLength`. */
export function slugify(input: string, maxLength = 200): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) throw new RangeError('maxLength must be a positive integer');
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= maxLength) return s;
  const cut = s.slice(0, maxLength);
  const lastHyphen = cut.lastIndexOf('-');
  // Prefer cutting at a word boundary; fall back to a hard cut for one very long word.
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/g, '');
}

/** First free slug: `base`, then `base-2`, `base-3`, … (suffix kept within `maxLength`). Throws on an empty base. */
export function uniqueSlug(base: string, isTaken: (slug: string) => boolean, maxLength = 200): string {
  const root = slugify(base, maxLength);
  if (!root) throw new RangeError(`cannot derive a slug from ${JSON.stringify(base)}`);
  if (!isTaken(root)) return root;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const candidate = slugify(root, maxLength - suffix.length) + suffix;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`no free slug for ${root}`);
}
