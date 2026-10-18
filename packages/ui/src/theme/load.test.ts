import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_THEME_SLUG, ThemeError, findThemesDir, loadTheme, mergeTokens } from './load';

const realThemesDir = findThemesDir(__dirname);

describe('mergeTokens', () => {
  it('merges nested objects and lets the overlay win', () => {
    const out = mergeTokens(
      { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] },
      { nested: { y: 3, z: 4 }, list: [9] },
    );
    expect(out).toEqual({ a: 1, nested: { x: 1, y: 3, z: 4 }, list: [9] });
  });

  it('treats null as "fall back to the base"', () => {
    const out = mergeTokens({ a: 1, nested: { x: 1 } }, { a: null, nested: { x: null } });
    expect(out).toEqual({ a: 1, nested: { x: 1 } });
  });

  it('does not mutate its inputs', () => {
    const base = { nested: { x: 1 } };
    const overlay = { nested: { x: 2 } };
    mergeTokens(base, overlay);
    expect(base).toEqual({ nested: { x: 1 } });
    expect(overlay).toEqual({ nested: { x: 2 } });
  });
});

describe('loadTheme (Foresite base)', () => {
  it('loads and resolves every semantic colour to hex', () => {
    const theme = loadTheme({ slug: BASE_THEME_SLUG, themesDir: realThemesDir });
    expect(theme.slug).toBe('foresite');
    expect(theme.appName).toBe('Foresite');
    expect(theme.colours.light.bg).toBe('#F4F7F6');
    expect(theme.colours.dark.bg).toBe('#04282C');
    expect(theme.colours.light.series).toHaveLength(4);
    for (const mode of ['light', 'dark'] as const) {
      for (const [key, hex] of Object.entries(theme.colours[mode])) {
        if (key === 'series') continue;
        expect(hex).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
    expect(theme.type.sans).toBe('IBM Plex Sans');
    expect(theme.credit).toBe('Built by Foresite');
  });

  it('defaults to the foresite theme when no env var is set', () => {
    const previous = process.env.NEXT_PUBLIC_THEME;
    delete process.env.NEXT_PUBLIC_THEME;
    try {
      expect(loadTheme({ themesDir: realThemesDir }).slug).toBe('foresite');
    } finally {
      if (previous !== undefined) process.env.NEXT_PUBLIC_THEME = previous;
    }
  });

  it('rejects slugs that could escape the themes folder', () => {
    expect(() => loadTheme({ slug: '../etc', themesDir: realThemesDir })).toThrow(ThemeError);
    expect(() => loadTheme({ slug: 'Foo Bar', themesDir: realThemesDir })).toThrow(
      /not a valid theme name/,
    );
  });

  it('names the available themes when the requested one is missing', () => {
    expect(() => loadTheme({ slug: 'nope', themesDir: realThemesDir })).toThrow(
      /Theme "nope" .*Available themes: foresite/,
    );
  });
});

describe('loadTheme (client overlay)', () => {
  let themesDir: string;

  beforeEach(() => {
    themesDir = mkdtempSync(join(tmpdir(), 'foresite-themes-'));
    mkdirSync(join(themesDir, 'foresite'));
    // Re-use the real base so the test tracks the real file.
    copyFileSync(
      join(realThemesDir, 'foresite', 'tokens.json'),
      join(themesDir, 'foresite', 'tokens.json'),
    );
  });

  afterEach(() => {
    rmSync(themesDir, { recursive: true, force: true });
  });

  function writeClient(slug: string, overlay: unknown) {
    mkdirSync(join(themesDir, slug), { recursive: true });
    writeFileSync(join(themesDir, slug, 'tokens.json'), JSON.stringify(overlay));
  }

  it('merges a client theme over the base and resolves new palette colours', () => {
    writeClient('acme', {
      client: { name: 'Acme Hotel', appName: 'Acme Live', appShortName: 'Acme' },
      palette: { brand: '#112233', accent: '#ffcc00', accentText: '#5a4300' },
      semantic: {
        light: { brand: 'brand', action: 'accent', link: 'accentText' },
        dark: { brand: 'brand', action: 'accent', link: 'accent' },
      },
      type: { sans: null, mono: null },
    });
    const theme = loadTheme({ slug: 'acme', themesDir });
    expect(theme.name).toBe('Acme Hotel');
    expect(theme.appName).toBe('Acme Live');
    expect(theme.appShortName).toBe('Acme');
    expect(theme.colours.light.brand).toBe('#112233');
    expect(theme.colours.light.action).toBe('#FFCC00');
    expect(theme.colours.light.link).toBe('#5A4300');
    // Untouched tokens fall back to the base.
    expect(theme.colours.light.bg).toBe('#F4F7F6');
    expect(theme.type.sans).toBe('IBM Plex Sans');
    expect(theme.dir).toBe(join(themesDir, 'acme'));
  });

  it('fails clearly when a semantic token names an unknown palette colour', () => {
    writeClient('acme', { semantic: { light: { action: 'accent' } } });
    expect(() => loadTheme({ slug: 'acme', themesDir })).toThrow(
      /semantic\.light\.action refers to palette colour "accent", which is not defined/,
    );
  });

  it('fails clearly on a bad hex value, naming the path', () => {
    writeClient('acme', { palette: { brand: 'blue' } });
    expect(() => loadTheme({ slug: 'acme', themesDir })).toThrow(
      /palette\.brand: must be a 6-digit hex/,
    );
  });

  it('fails clearly on an unknown key (typo)', () => {
    writeClient('acme', { semantc: {} });
    expect(() => loadTheme({ slug: 'acme', themesDir })).toThrow(/Unrecognized key/);
  });

  it('fails clearly on invalid JSON', () => {
    mkdirSync(join(themesDir, 'acme'), { recursive: true });
    writeFileSync(join(themesDir, 'acme', 'tokens.json'), '{ not json');
    expect(() => loadTheme({ slug: 'acme', themesDir })).toThrow(/not valid JSON/);
  });

  it('accepts literal hex values in semantic tokens', () => {
    writeClient('acme', { semantic: { light: { brand: '#abcdef' } } });
    expect(loadTheme({ slug: 'acme', themesDir }).colours.light.brand).toBe('#ABCDEF');
  });
});

describe('findThemesDir', () => {
  it('walks up from a nested folder', () => {
    expect(findThemesDir(join(realThemesDir, '..', 'packages', 'ui', 'src'))).toBe(realThemesDir);
  });

  it('throws when nothing is found', () => {
    expect(() => findThemesDir(tmpdir())).toThrow(ThemeError);
  });
});
