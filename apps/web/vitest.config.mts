import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', include: ['test/**/*.test.{mjs,ts,tsx}'], setupFiles: ['test/setup.ts'], css: false,
    // jsdom + axe tests are slow when every package's suite runs at once (pnpm test); same budget as the admin.
    testTimeout: 20_000 },
});
