import { defineConfig, devices } from '@playwright/test';
import { ingestServerEnv } from './e2e/ingest-env';

const isCI = process.env.CI === 'true' || process.env.CI === '1';
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';

// On machines where the browser was installed by other means (e.g. a shared
// image), point at it with PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. CI installs its
// own browsers and leaves this unset.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(executablePath !== undefined ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: 'phone-light',
      use: { ...devices['Pixel 7'], colorScheme: 'light' },
    },
    {
      name: 'desktop-dark',
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark' },
    },
  ],
  // Smoke tests run against the production build: `npm run build` first.
  // The ingest tests use in-memory storage with synthetic devices whose secret
  // is generated for this run (see e2e/ingest-env.ts).
  webServer: {
    command: 'npm run start',
    env: ingestServerEnv(),
    url: `${baseURL}/api/health`,
    reuseExistingServer: !isCI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
