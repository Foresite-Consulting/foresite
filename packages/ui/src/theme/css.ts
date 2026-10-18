import { SEMANTIC_KEYS, type ResolvedColours, type ResolvedTheme } from './schema';

/**
 * CSS custom property names. Colours are stored as space-separated RGB channels
 * (e.g. `4 40 44`) so Tailwind can apply opacity modifiers:
 * `rgb(var(--color-bg) / 0.5)`.
 */
export const cssVar = {
  colour: (key: string) => `--color-${key}`,
  series: (index: number) => `--color-series-${index + 1}`,
  fontSans: '--font-sans',
  fontMono: '--font-mono',
  /** Set by the app when it has loaded a web font (e.g. via next/font). */
  loadedSans: '--font-loaded-sans',
  loadedMono: '--font-loaded-mono',
  text: (step: string) => `--text-${step}`,
} as const;

export function hexToRgbChannels(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

function colourDeclarations(colours: ResolvedColours): string[] {
  const lines = SEMANTIC_KEYS.map(
    (key) => `${cssVar.colour(key)}: ${hexToRgbChannels(colours[key])};`,
  );
  colours.series.forEach((hex, index) => {
    lines.push(`${cssVar.series(index)}: ${hexToRgbChannels(hex)};`);
  });
  return lines;
}

function fontStack(family: string, loadedVar: string, generic: string): string {
  return `var(${loadedVar}, "${family}"), ${generic}`;
}

const indent = (lines: string[], depth: number) =>
  lines.map((line) => `${'  '.repeat(depth)}${line}`).join('\n');

/**
 * Build the stylesheet that carries the theme into the browser.
 *
 * - Light tokens on `:root`.
 * - Dark tokens when the device prefers dark, unless `data-theme="light"` is set on `<html>`.
 * - Dark tokens whenever `data-theme="dark"` is set, whatever the device prefers.
 */
export function themeToCss(theme: ResolvedTheme): string {
  const light = colourDeclarations(theme.colours.light);
  const dark = colourDeclarations(theme.colours.dark);

  const typography = [
    `${cssVar.fontSans}: ${fontStack(theme.type.sans, cssVar.loadedSans, 'ui-sans-serif, system-ui, sans-serif')};`,
    `${cssVar.fontMono}: ${fontStack(theme.type.mono, cssVar.loadedMono, 'ui-monospace, SFMono-Regular, Menlo, monospace')};`,
    ...Object.entries(theme.type.scale).map(
      ([step, px]) => `${cssVar.text(step)}: ${(px / 16).toString()}rem;`,
    ),
  ];

  return [
    `/* Theme: ${theme.slug}. Generated from themes/${theme.slug}/tokens.json; do not edit by hand. */`,
    ':root {',
    indent(['color-scheme: light;', ...light, ...typography], 1),
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    indent(['color-scheme: dark;', ...dark], 2),
    '  }',
    '}',
    ':root[data-theme="dark"] {',
    indent(['color-scheme: dark;', ...dark], 1),
    '}',
    '',
  ].join('\n');
}
