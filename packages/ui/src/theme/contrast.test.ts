import { describe, expect, it } from 'vitest';
import {
  checkThemeContrast,
  contrastFailures,
  contrastRatio,
  formatContrastTable,
  hexToRgb,
  meetsAA,
  relativeLuminance,
  roundRatio,
} from './contrast';
import { findThemesDir, loadTheme } from './load';

const foresite = loadTheme({ slug: 'foresite', themesDir: findThemesDir(__dirname) });

describe('contrast maths', () => {
  it('parses hex colours', () => {
    expect(hexToRgb('#04282C')).toEqual({ r: 4, g: 40, b: 44 });
    expect(hexToRgb('ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(() => hexToRgb('#fff')).toThrow(/6-digit/);
  });

  it('matches the WCAG reference values', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 6);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 6);
    // #767676 on white is the classic "just passes AA" grey.
    expect(roundRatio(contrastRatio('#767676', '#FFFFFF'))).toBe(4.54);
    // #777777 on white just fails.
    expect(roundRatio(contrastRatio('#777777', '#FFFFFF'))).toBe(4.47);
  });

  it('rounds down so a near miss is not called a pass', () => {
    expect(roundRatio(4.4999)).toBe(4.49);
    expect(meetsAA(4.4999, 'text')).toBe(false);
    expect(meetsAA(4.5, 'text')).toBe(true);
    expect(meetsAA(3.0, 'ui')).toBe(true);
    expect(meetsAA(2.99, 'large-text')).toBe(false);
  });
});

describe('Foresite theme contrast (WCAG 2.1 AA)', () => {
  const results = checkThemeContrast(foresite);

  it('checks both modes and every required pairing', () => {
    expect(results.filter((r) => r.mode === 'light').length).toBeGreaterThan(10);
    expect(results.filter((r) => r.mode === 'dark').length).toBeGreaterThan(10);
  });

  it.each(results.filter((r) => !r.advisory).map((r) => [`${r.mode}: ${r.fg} on ${r.bg}`, r]))(
    '%s meets AA',
    (_name, result) => {
      expect(result.ratio, `${result.fgHex} on ${result.bgHex}`).toBeGreaterThanOrEqual(
        result.required,
      );
      expect(result.pass).toBe(true);
    },
  );

  it('has no required failures', () => {
    expect(contrastFailures(results)).toEqual([]);
  });

  it('records the brand-rule values the guide relies on', () => {
    // Ink on Coral (on-action on action): the guide's "Ink text on Coral" rule.
    const onAction = results.find((r) => r.mode === 'light' && r.fg === 'on-action');
    expect(onAction?.ratio).toBe(5.4);
    // Moss and Ember on Mist are the approved text colours on the light background.
    expect(
      results.find((r) => r.mode === 'light' && r.fg === 'text-secondary' && r.bg === 'bg')?.ratio,
    ).toBe(5.11);
    expect(results.find((r) => r.mode === 'light' && r.fg === 'link' && r.bg === 'bg')?.ratio).toBe(
      4.76,
    );
  });

  it('requires the focus indicator (link colour) to reach 3:1 on bg and surface in both modes', () => {
    const focus = results.filter((r) => r.note?.startsWith('focus indicator'));
    expect(focus.map((r) => `${r.mode}:${r.fg}/${r.bg}`).sort()).toEqual([
      'dark:link/bg',
      'dark:link/surface',
      'light:link/bg',
      'light:link/surface',
    ]);
    for (const r of focus) {
      expect(r.advisory).toBe(false);
      expect(r.required).toBe(3);
      expect(r.pass).toBe(true);
    }
  });

  it('fails a client theme whose link colour cannot carry a focus indicator', () => {
    // Coral as the link (and so the focus outline) on Mist/white is under 3:1.
    const weak = structuredClone(foresite);
    weak.colours.light.link = '#FF6650';
    const failures = contrastFailures(checkThemeContrast(weak));
    expect(failures.some((f) => f.note?.startsWith('focus indicator') && f.bg === 'bg')).toBe(true);
    expect(failures.some((f) => f.note?.startsWith('focus indicator') && f.bg === 'surface')).toBe(
      true,
    );
  });

  it('quotes the same Coral-on-Serpentine ratio in the theme rules as the checker reports', () => {
    // theme:check rounds down (roundRatio), so the recorded figure is 4.48:1.
    const ratio = roundRatio(contrastRatio(foresite.palette.coral!, foresite.palette.serpentine!));
    expect(ratio).toBe(4.48);
    const rule = foresite.rules.find((r) => r.includes('Coral on Serpentine'));
    expect(rule).toContain(`${ratio.toFixed(2)}:1`);
  });

  it('prints a table with a row per pairing', () => {
    const table = formatContrastTable(results);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^Mode\s+Pairing\s+Colours\s+Ratio\s+Needs\s+Result/);
    expect(lines).toHaveLength(results.length + 2);
    expect(table).toContain('text-primary on bg');
  });
});
