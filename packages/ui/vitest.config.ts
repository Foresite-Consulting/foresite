import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    name: 'ui',
    environment: 'jsdom',
    setupFiles: ['./test/vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
