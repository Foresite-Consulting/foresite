import { describe, expect, it } from 'vitest';
import { hexToRgbChannels, themeToCss } from './css';
import { findThemesDir, loadTheme } from './load';
import { SEMANTIC_KEYS } from './schema';
import { foresitePreset } from './tailwind-preset';

const theme = loadTheme({ slug: 'foresite', themesDir: findThemesDir(__dirname) });

describe('themeToCss', () => {
  const css = themeToCss(theme);

  it('converts hex to RGB channels', () => {
    expect(hexToRgbChannels('#04282C')).toBe('4 40 44');
    expect(hexToRgbChannels('#FFFFFF')).toBe('255 255 255');
  });

  it('emits every semantic token for light on :root', () => {
    const root = css.slice(css.indexOf(':root {'), css.indexOf('@media'));
    for (const key of SEMANTIC_KEYS) expect(root).toContain(`--color-${key}: `);
    expect(root).toContain('--color-bg: 244 247 246;');
    expect(root).toContain('--color-series-1: 109 160 151;');
    expect(root).toContain('color-scheme: light;');
  });

  it('emits dark tokens for the device preference and for the data-theme override', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark) {');
    expect(css).toContain(':root:not([data-theme="light"]) {');
    expect(css).toContain(':root[data-theme="dark"] {');
    expect(css.match(/--color-bg: 4 40 44;/g)).toHaveLength(2);
  });

  it('carries the font families and type scale from the theme', () => {
    expect(css).toContain('--font-sans: var(--font-loaded-sans, "IBM Plex Sans"), ui-sans-serif');
    expect(css).toContain('--font-mono: var(--font-loaded-mono, "IBM Plex Mono"), ui-monospace');
    expect(css).toContain('--text-display: 4.5rem;');
    expect(css).toContain('--text-body: 1rem;');
    expect(css).toContain('--text-label: 0.75rem;');
  });

  it('contains no raw hex colours, so nothing bypasses the variables', () => {
    const body = css.split('\n').slice(1).join('\n'); // skip the comment line
    expect(body).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});

describe('foresitePreset', () => {
  it('maps every semantic colour to its variable and drops the default palette', () => {
    const colours = foresitePreset.theme?.colors as Record<string, unknown>;
    for (const key of SEMANTIC_KEYS) {
      expect(colours[key]).toBe(`rgb(var(--color-${key}) / <alpha-value>)`);
    }
    expect(colours).not.toHaveProperty('red');
    expect(colours).not.toHaveProperty('slate');
    expect(colours.series).toMatchObject({ '1': 'rgb(var(--color-series-1) / <alpha-value>)' });
  });

  it('exposes the type scale and the 44 px tap target', () => {
    const extend = foresitePreset.theme?.extend as Record<string, Record<string, unknown>>;
    expect(extend.fontSize).toHaveProperty('display');
    expect(extend.fontSize).toHaveProperty('label');
    expect(extend.minHeight).toEqual({ tap: '44px' });
  });
});
