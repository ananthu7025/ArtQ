// Brand fonts (design-system.md §3), self-hosted through next/font from the @fontsource files: no request to Google at
// build or run time, Latin subset only, display: swap.
import localFont from 'next/font/local';

export const inter = localFont({ src: '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', weight: '100 900', display: 'swap', variable: '--font-inter' });
export const playfair = localFont({
  src: [
    { path: '../node_modules/@fontsource-variable/playfair-display/files/playfair-display-latin-wght-normal.woff2', weight: '400 900', style: 'normal' },
    { path: '../node_modules/@fontsource-variable/playfair-display/files/playfair-display-latin-wght-italic.woff2', weight: '400 900', style: 'italic' },
  ],
  display: 'swap', variable: '--font-playfair',
});
export const tenor = localFont({ src: '../node_modules/@fontsource/tenor-sans/files/tenor-sans-latin-400-normal.woff2', weight: '400', display: 'swap', variable: '--font-tenor' });
