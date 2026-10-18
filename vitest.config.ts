import { defineConfig } from 'vitest/config';

// One Vitest run for the whole monorepo. Each workspace that has unit tests
// owns its own vitest.config.ts; this file only lists them.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
    passWithNoTests: false,
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
  },
});
