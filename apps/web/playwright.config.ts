import { defineConfig, devices } from '@playwright/test';
import { ingestServerEnv } from './e2e/ingest-env';

const isCI = process.env.CI === 'true' || process.env.CI === '1';
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';
const port = new URL(baseURL).port || '3000';
// Never test against a server we did not start, unless asked: another
// checkout's server on the same port would answer with its own code and its
// own synthetic devices. Set PLAYWRIGHT_REUSE_SERVER=1 to reuse one (it must
// have been started with the same E2E_INGEST_SECRET).
const reuseServer = !isCI && process.env.PLAYWRIGHT_REUSE_SERVER === '1';

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
  // The port comes from PLAYWRIGHT_BASE_URL, so a free one can be chosen. If
  // something already listens there and reuse is off, Playwright stops with an
  // error instead of testing that server.
  webServer: {
    command: `npx next start --hostname 127.0.0.1 --port ${port}`,
    env: ingestServerEnv(),
    url: `${baseURL}/api/health`,
    reuseExistingServer: reuseServer,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
