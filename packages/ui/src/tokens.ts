// Single source of truth for colour tokens (design-system.md §2). tokens.css and theme.css are tested against this.
export const color = {
  'brand-50': '#e6f4f3',
  'brand-300': '#5eead4',
  'brand-400': '#00c4c7',
  'brand-500': '#00a99d',
  'brand-700': '#00756f',
  'brand-800': '#005f5a',
  'accent-500': '#009bc2',
  'surface-0': '#ffffff',
  'surface-50': '#f8fafc',
  'surface-100': '#f1f5f9',
  'surface-200': '#e2e8f0',
  'border-input': '#64748b',
  'ink-900': '#111827',
  'ink-700': '#374151',
  'ink-500': '#64748b',
  'success-700': '#15803d',
  'warning-700': '#b45309',
  'warning-bg': '#fef3c7',
  'warning-ink': '#7c2d12',
  'danger-700': '#b91c1c',
  'sidebar-text': '#e5e7eb',
  'sidebar-muted': '#9ca3af',
} as const;
export type ColorToken = keyof typeof color;

/** WCAG 2.1: 4.5 for normal text, 3 for large text and UI component boundaries. */
export type PairUse = 'text' | 'ui' | 'decorative';
export type ContrastPair = { fg: ColorToken | '#ffffff'; bg: ColorToken; use: PairUse; where: string };

// Every foreground/background pairing the design system allows (design-system.md §2.3).
export const allowedPairs: ContrastPair[] = [
  { fg: '#ffffff', bg: 'brand-700', use: 'text', where: 'primary button, selected admin nav' },
  { fg: '#ffffff', bg: 'brand-800', use: 'text', where: 'button hover, announcement bar' },
  { fg: 'brand-700', bg: 'surface-0', use: 'text', where: 'links, small teal text' },
  { fg: 'brand-700', bg: 'surface-50', use: 'text', where: 'teal text on page background' },
  { fg: 'brand-700', bg: 'surface-100', use: 'text', where: 'teal text on section background' },
  { fg: 'brand-800', bg: 'brand-50', use: 'text', where: 'selected chip' },
  { fg: 'ink-700', bg: 'surface-0', use: 'text', where: 'body text' },
  { fg: 'ink-900', bg: 'surface-50', use: 'text', where: 'headings' },
  { fg: 'ink-500', bg: 'surface-0', use: 'text', where: 'secondary text, placeholders' },
  { fg: 'success-700', bg: 'surface-0', use: 'text', where: 'success text' },
  { fg: 'warning-700', bg: 'surface-0', use: 'text', where: 'warning text' },
  { fg: 'warning-ink', bg: 'warning-bg', use: 'text', where: 'warning badge' },
  { fg: 'danger-700', bg: 'surface-0', use: 'text', where: 'error text' },
  { fg: '#ffffff', bg: 'danger-700', use: 'text', where: 'destructive button' },
  { fg: '#ffffff', bg: 'success-700', use: 'text', where: 'success badge' },
  { fg: 'sidebar-text', bg: 'ink-900', use: 'text', where: 'admin sidebar items' },
  { fg: 'sidebar-muted', bg: 'ink-900', use: 'text', where: 'admin sidebar group headings' },
  { fg: 'brand-300', bg: 'ink-900', use: 'text', where: 'focus ring / links on dark' },
  { fg: 'border-input', bg: 'surface-0', use: 'ui', where: 'input borders' },
  { fg: 'brand-700', bg: 'ink-900', use: 'ui', where: 'selected nav item vs sidebar' },
];

/** Pairs that must NOT be used for text (kept so tests prove the checker would catch them). */
export const forbiddenTextPairs: ContrastPair[] = [
  { fg: '#ffffff', bg: 'brand-500', use: 'decorative', where: 'reference site buttons (2.93:1)' },
  { fg: '#ffffff', bg: 'brand-400', use: 'decorative', where: 'gradient middle' },
  { fg: 'brand-500', bg: 'surface-0', use: 'decorative', where: 'section-title lines only' },
];
