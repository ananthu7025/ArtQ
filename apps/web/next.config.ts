import type { NextConfig } from 'next';

// Frontend only (architecture.md §1.1): no route handlers, no Server Actions, no secrets.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};
export default config;
