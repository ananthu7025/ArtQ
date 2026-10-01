// WCAG 2.1 relative luminance and contrast ratio.
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new TypeError(`expected #rrggbb, got ${JSON.stringify(hex)}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

export const MIN_RATIO = { text: 4.5, ui: 3 } as const;
