import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Coverage applies when this config is the root, i.e. `npm run coverage -w packages/core`.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test-support.ts', 'src/synthetic/cli-entry.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
