import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedTheme } from '@foresite/ui/theme';

// next/font only works inside the Next compiler; stand in for it here.
vi.mock('next/font/local', () => ({
  default: (options: { variable: string }) => ({
    variable: options.variable === '--font-loaded-sans' ? 'plex-sans-var' : 'plex-mono-var',
  }),
}));

function theme(sans: string, mono: string): ResolvedTheme {
  return { slug: 'acme', type: { sans, mono } } as unknown as ResolvedTheme;
}

async function freshFonts() {
  vi.resetModules();
  return import('./fonts');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fontClassNames', () => {
  it('returns the registered font variables and does not warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fontClassNames } = await freshFonts();
    expect(fontClassNames(theme('IBM Plex Sans', 'IBM Plex Mono'))).toBe(
      'plex-sans-var plex-mono-var',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back for an unregistered family and warns once per family, not per render', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fontClassNames } = await freshFonts();
    for (let i = 0; i < 5; i += 1) {
      expect(fontClassNames(theme('Comic Sans', 'IBM Plex Mono'))).toBe('plex-mono-var');
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/"Comic Sans", which is not registered/);

    fontClassNames(theme('Comic Sans', 'Courier Prime'));
    fontClassNames(theme('Comic Sans', 'Courier Prime'));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toMatch(/"Courier Prime"/);
  });
});

describe('font files', () => {
  const dir = path.resolve(__dirname, '..', 'app', 'fonts');
  const source = readFileSync(path.resolve(__dirname, 'fonts.ts'), 'utf8');

  it('loads only local files, never Google Fonts', () => {
    expect(source).not.toMatch(/next\/font\/google|fonts\.googleapis|fonts\.gstatic/);
    expect(source).toMatch(/from 'next\/font\/local'/);
  });

  it('every referenced file is committed, is woff2 and is small', () => {
    const paths = [...source.matchAll(/path: '\.\.\/app\/fonts\/([^']+)'/g)].map((m) => m[1]);
    expect(paths).toHaveLength(5);
    for (const name of paths) {
      const bytes = readFileSync(path.join(dir, name ?? ''));
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
      expect(bytes.length).toBeLessThan(40_000);
    }
  });

  it('ships the OFL licence and a source note', () => {
    expect(readFileSync(path.join(dir, 'OFL.txt'), 'utf8')).toMatch(
      /SIL OPEN FONT LICENSE Version 1\.1/,
    );
    expect(readdirSync(dir)).toContain('README.md');
  });
});
