import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** Collect console errors and uncaught exceptions for the life of the page. */
function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  return errors;
}

test.describe('home page', () => {
  test('loads with the demo KPI tiles and no console errors', async ({ page }) => {
    const errors = watchConsole(page);
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await expect(page.getByText('Demo data', { exact: true }).first()).toBeVisible();

    const tiles = page.getByRole('article');
    await expect(tiles).toHaveCount(6);
    for (const tile of await tiles.all()) await expect(tile).toBeVisible();

    await expect(page.getByRole('article', { name: 'Revenue today' })).toContainText('ex GST');
    await expect(page.getByRole('article', { name: 'Revenue today' })).toContainText(
      'Up 4.2% vs budget',
    );
    await expect(page.getByRole('article', { name: 'Expected revenue tonight' })).toContainText(
      'Likely range $8,600–$10,300',
    );
    await expect(page.getByText('Built by Foresite')).toBeVisible();

    // Give any CSP violation reports time to land in the console.
    await page.waitForLoadState('networkidle');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('has no serious or critical accessibility violations', async ({ page }) => {
    await page.goto('/');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(
      blocking,
      JSON.stringify(
        blocking.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
        null,
        2,
      ),
    ).toEqual([]);
    // Report, but do not fail on, lesser findings.
    if (results.violations.length > 0) {
      console.info(
        'axe (non-blocking):',
        results.violations.map((v) => `${v.id} (${v.impact ?? 'n/a'})`).join(', '),
      );
    }
  });

  test('sends the security headers', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['x-powered-by']).toBeUndefined();

    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  test('honours the data-theme override', async ({ page }) => {
    await page.goto('/');
    const background = () =>
      page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    const initial = await background();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    const dark = await background();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    const light = await background();
    expect(light).toBe('rgb(244, 247, 246)');
    expect(dark).toBe('rgb(4, 40, 44)');
    expect([light, dark]).toContain(initial);
  });

  test('registers the service worker', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'service workers are only exercised in Chromium');
    await page.goto('/');
    const scope = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.scope;
    });
    expect(scope).toMatch(/\/$/);
  });
});

test.describe('PWA plumbing', () => {
  test('serves a manifest built from the theme', async ({ request }) => {
    const response = await request.get('/manifest.webmanifest');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/manifest+json');
    const manifest = (await response.json()) as {
      name: string;
      short_name: string;
      theme_color: string;
      background_color: string;
      display: string;
      icons: { src: string; sizes: string; purpose?: string }[];
    };
    expect(manifest.name).toBe('Foresite');
    expect(manifest.short_name).toBe('Foresite');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#[0-9A-F]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9A-F]{6}$/);
    expect(manifest.icons).toHaveLength(3);
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) {
      const iconResponse = await request.get(icon.src);
      expect(iconResponse.status(), icon.src).toBe(200);
      expect(iconResponse.headers()['content-type']).toBe('image/png');
    }
  });

  test('refuses theme asset paths that are not declared', async ({ request }) => {
    expect((await request.get('/theme-assets/tokens.json')).status()).toBe(404);
    expect((await request.get('/theme-assets/..%2Ftokens.json')).status()).toBe(404);
  });

  test('health route answers ok', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('offline page shows the last numbers once the dashboard has been seen', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/offline');
    await expect(page.getByRole('heading', { level: 1, name: "You're offline" })).toBeVisible();
    await expect(page.getByText('No saved numbers on this device yet')).toBeVisible();

    await page.goto('/');
    await expect(page.getByRole('article')).toHaveCount(6);
    await page.goto('/offline');
    await expect(page.getByText('Showing the last numbers we had')).toBeVisible();
    await expect(page.getByText(/Last updated/)).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(6);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('service worker caching rules', () => {
  // Playwright's offline emulation does not reach service-worker fetches, so
  // the navigation fallback itself is covered by the unit test in
  // test/sw.test.ts. Here we check what the installed worker put in the cache.
  test('precaches the offline page and its chunks, and never caches API responses', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'service workers are only exercised in Chromium');
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.evaluate(() => fetch('/api/health'));
    await page.goto('/');

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const entries: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) entries.push(new URL(request.url).pathname);
      }
      return { names, entries };
    });

    expect(cached.names).toEqual(['foresite-v1']);
    expect(cached.entries).toContain('/offline');
    expect(cached.entries.some((path) => path.startsWith('/_next/static/'))).toBe(true);
    expect(cached.entries.filter((path) => path.startsWith('/api/'))).toEqual([]);
    expect(cached.entries).not.toContain('/');
  });
});
