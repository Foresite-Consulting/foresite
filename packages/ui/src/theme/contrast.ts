import { THEME_MODES, type ResolvedTheme, type ThemeMode } from './schema';

/** WCAG 2.1 AA minimum contrast ratios. */
export const WCAG_AA = {
  /** Body text under roughly 18 pt (24 px), or 14 pt (18.66 px) bold. */
  normalText: 4.5,
  /** Large text, UI components and graphical objects (1.4.3 and 1.4.11). */
  largeText: 3,
  ui: 3,
} as const;

export type PairingKind = 'text' | 'large-text' | 'ui' | 'chart' | 'decorative';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): RGB {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) throw new Error(`Not a 6-digit hex colour: "${hex}"`);
  const value = Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance per WCAG 2.1 (sRGB). */
export function relativeLuminance(colour: RGB | string): number {
  const { r, g, b } = typeof colour === 'string' ? hexToRgb(colour) : colour;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colours, from 1 to 21. Order does not matter. */
export function contrastRatio(a: RGB | string, b: RGB | string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** Round the way auditors report it: two decimals, rounding down so 4.4999 is not called 4.5. */
export function roundRatio(ratio: number): number {
  return Math.floor(ratio * 100) / 100;
}

export function meetsAA(ratio: number, kind: PairingKind = 'text'): boolean {
  return roundRatio(ratio) >= requiredRatio(kind);
}

export function requiredRatio(kind: PairingKind): number {
  return kind === 'text' ? WCAG_AA.normalText : WCAG_AA.ui;
}

export interface Pairing {
  /** Semantic token drawn in front (text, icon, line). */
  fg: string;
  /** Semantic token behind it. */
  bg: string;
  kind: PairingKind;
  /** Advisory pairings are reported but do not fail a theme. */
  advisory: boolean;
  note?: string;
}

/**
 * Every pairing the design system actually produces. Required pairings must
 * pass AA; advisory ones are reported so a designer can judge them.
 */
export const THEME_PAIRINGS: readonly Pairing[] = [
  { fg: 'text-primary', bg: 'bg', kind: 'text', advisory: false },
  { fg: 'text-primary', bg: 'surface', kind: 'text', advisory: false },
  { fg: 'text-secondary', bg: 'bg', kind: 'text', advisory: false },
  { fg: 'text-secondary', bg: 'surface', kind: 'text', advisory: false },
  { fg: 'link', bg: 'bg', kind: 'text', advisory: false },
  { fg: 'link', bg: 'surface', kind: 'text', advisory: false },
  { fg: 'on-action', bg: 'action', kind: 'text', advisory: false },
  {
    fg: 'link',
    bg: 'bg',
    kind: 'ui',
    advisory: false,
    note: 'focus indicator (WCAG 2.4.7 / 1.4.11): the focus outline uses the link colour',
  },
  { fg: 'link', bg: 'surface', kind: 'ui', advisory: false, note: 'focus indicator' },
  {
    fg: 'positive',
    bg: 'surface',
    kind: 'ui',
    advisory: false,
    note: 'indicator icon only; the words beside it use text colours',
  },
  { fg: 'positive', bg: 'bg', kind: 'ui', advisory: false, note: 'indicator icon only' },
  { fg: 'negative', bg: 'surface', kind: 'ui', advisory: false, note: 'indicator icon only' },
  { fg: 'negative', bg: 'bg', kind: 'ui', advisory: false, note: 'indicator icon only' },
  { fg: 'forecast', bg: 'surface', kind: 'chart', advisory: false, note: 'forecast line' },
  { fg: 'forecast', bg: 'bg', kind: 'chart', advisory: false, note: 'forecast line' },
  {
    fg: 'action',
    bg: 'surface',
    kind: 'ui',
    advisory: true,
    note: 'button fill; the on-action label identifies the button, so 1.4.11 does not bind',
  },
  { fg: 'action', bg: 'bg', kind: 'ui', advisory: true, note: 'button fill against the page' },
  {
    fg: 'brand',
    bg: 'surface',
    kind: 'decorative',
    advisory: true,
    note: 'brand accent is decorative, never text',
  },
  { fg: 'brand', bg: 'bg', kind: 'decorative', advisory: true, note: 'decorative' },
  {
    fg: 'border',
    bg: 'surface',
    kind: 'decorative',
    advisory: true,
    note: 'borders are decorative; layout and spacing carry structure',
  },
  { fg: 'border', bg: 'bg', kind: 'decorative', advisory: true, note: 'decorative' },
];

export interface ContrastResult {
  mode: ThemeMode;
  fg: string;
  bg: string;
  fgHex: string;
  bgHex: string;
  ratio: number;
  required: number;
  pass: boolean;
  kind: PairingKind;
  advisory: boolean;
  note: string | undefined;
}

function lookup(theme: ResolvedTheme, mode: ThemeMode, token: string): string {
  const seriesMatch = /^series\[(\d+)\]$/.exec(token);
  const colours = theme.colours[mode];
  if (seriesMatch?.[1] !== undefined) {
    const hex = colours.series[Number(seriesMatch[1])];
    if (hex === undefined) throw new Error(`No ${token} in ${mode} series`);
    return hex;
  }
  const hex = (colours as unknown as Record<string, string | undefined>)[token];
  if (hex === undefined) throw new Error(`Unknown semantic token "${token}"`);
  return hex;
}

/**
 * Check every pairing in both modes. Chart series are appended as advisory
 * pairings against `surface`: comparison series are deliberately muted, so
 * they are reported rather than enforced.
 */
export function checkThemeContrast(theme: ResolvedTheme): ContrastResult[] {
  const results: ContrastResult[] = [];
  for (const mode of THEME_MODES) {
    const pairings: Pairing[] = [
      ...THEME_PAIRINGS,
      ...theme.colours[mode].series.map<Pairing>((_, index) => ({
        fg: `series[${index}]`,
        bg: 'surface',
        kind: 'chart',
        advisory: true,
        note: index === 1 ? 'comparison series, muted by design' : 'chart line',
      })),
    ];
    for (const pairing of pairings) {
      const fgHex = lookup(theme, mode, pairing.fg);
      const bgHex = lookup(theme, mode, pairing.bg);
      const ratio = roundRatio(contrastRatio(fgHex, bgHex));
      const required = requiredRatio(pairing.kind);
      results.push({
        mode,
        fg: pairing.fg,
        bg: pairing.bg,
        fgHex,
        bgHex,
        ratio,
        required,
        pass: ratio >= required,
        kind: pairing.kind,
        advisory: pairing.advisory,
        note: pairing.note,
      });
    }
  }
  return results;
}

/** Required pairings that fail. Empty means the theme passes AA. */
export function contrastFailures(results: ContrastResult[]): ContrastResult[] {
  return results.filter((result) => !result.advisory && !result.pass);
}

/** A fixed-width text table for terminals and CI logs. */
export function formatContrastTable(results: ContrastResult[]): string {
  const rows = results.map((r) => [
    r.mode,
    `${r.fg} on ${r.bg}`,
    `${r.fgHex} / ${r.bgHex}`,
    r.ratio.toFixed(2),
    `${r.required.toFixed(1)}:1`,
    r.pass ? 'pass' : r.advisory ? 'warn' : 'FAIL',
    r.note ?? '',
  ]);
  const header = ['Mode', 'Pairing', 'Colours', 'Ratio', 'Needs', 'Result', 'Note'];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}
