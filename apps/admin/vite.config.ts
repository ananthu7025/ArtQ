import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Host(s) the preview server accepts besides localhost (comma-separated), e.g. the Nginx-proxied admin domain.
const allowedHosts = process.env.VITE_PREVIEW_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true, ...(allowedHosts?.length ? { allowedHosts } : {}) },
  test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'], setupFiles: ['test/setup.ts'], css: false,
    // jsdom + axe tests take ~0.6 s alone but several seconds when every package's suite runs at once (pnpm test).
    testTimeout: 20_000 },
});
