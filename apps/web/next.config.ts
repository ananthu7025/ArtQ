import type { NextConfig } from 'next';

// Frontend only (architecture.md §1.1): no route handlers, no Server Actions, no secrets.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The browser tests build into their own folder (against the e2e API) so they never replace the normal build.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
};
export default config;
