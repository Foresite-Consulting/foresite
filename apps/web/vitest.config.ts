import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // Vitest does not understand the "server-only" marker; the real module
      // throws outside a React Server Component.
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    name: 'web',
    environment: 'node',
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
