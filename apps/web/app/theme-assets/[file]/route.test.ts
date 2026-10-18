import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedTheme } from '@foresite/ui/theme';

const state: { theme: ResolvedTheme | undefined } = { theme: undefined };

vi.mock('@/lib/theme', () => ({
  getTheme: () => {
    if (state.theme === undefined) throw new Error('theme not set');
    return state.theme;
  },
}));

const { GET } = await import('./route');

let root: string;
let themeDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'foresite-theme-assets-'));
  themeDir = join(root, 'acme');
  mkdirSync(themeDir);
  writeFileSync(join(themeDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(themeDir, 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(themeDir, 'notes.txt'), 'not an asset');
  writeFileSync(join(root, 'secret.png'), 'outside the theme folder');
  writeFileSync(join(themeDir, 'tokens.json'), '{}');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  // Built by hand (not through the schema) so the route's own checks are tested.
  state.theme = {
    slug: 'acme',
    dir: themeDir,
    assets: {
      logo: 'logo.svg',
      logoOnDark: null,
      favicon: null,
      icons: ['icon-192.png', 'notes.txt', 'missing.png'],
    },
  } as unknown as ResolvedTheme;
});

function get(file: string) {
  return GET(new Request(`https://venue.example/theme-assets/${encodeURIComponent(file)}`), {
    params: Promise.resolve({ file }),
  });
}

function expectSafeHeaders(response: Response) {
  expect(response.headers.get('content-security-policy')).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
}

describe('GET /theme-assets/[file]', () => {
  it('serves a declared SVG with a locked-down CSP, nosniff and CORP', async () => {
    const response = await get('logo.svg');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('cache-control')).toContain('max-age=86400');
    expectSafeHeaders(response);
    expect(await response.text()).toContain('<svg');
  });

  it('serves a declared PNG with the PNG content type', async () => {
    const response = await get('icon-192.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expectSafeHeaders(response);
  });

  it('404s for files the theme does not declare', async () => {
    for (const file of ['tokens.json', 'logo-on-dark.svg', 'secret.png']) {
      const response = await get(file);
      expect(response.status, file).toBe(404);
      expectSafeHeaders(response);
    }
  });

  it('404s for path traversal, encoded or not', async () => {
    for (const file of ['../secret.png', '..%2Fsecret.png', '..\\secret.png', '/etc/passwd']) {
      expect((await get(file)).status, file).toBe(404);
    }
  });

  it('404s for a declared file with an extension it has no content type for', async () => {
    expect((await get('notes.txt')).status).toBe(404);
  });

  it('404s when a declared file is missing on disk', async () => {
    expect((await get('missing.png')).status).toBe(404);
  });
});
