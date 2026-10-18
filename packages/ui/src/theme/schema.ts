import { z } from 'zod';

/**
 * Semantic colour tokens. Components use only these names (via Tailwind
 * utilities or CSS variables), never palette names or hex values, so a client
 * theme can re-map them without touching code.
 */
export const SEMANTIC_KEYS = [
  'bg',
  'surface',
  'text-primary',
  'text-secondary',
  'brand',
  'action',
  'on-action',
  'link',
  'border',
  'positive',
  'negative',
  'forecast',
] as const;

export type SemanticKey = (typeof SEMANTIC_KEYS)[number];
export type ThemeMode = 'light' | 'dark';
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark'];

export const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

const hexColour = z
  .string()
  .regex(HEX_PATTERN, 'must be a 6-digit hex colour such as #04282C (no shorthand, no alpha)');

/** A palette name (e.g. "ink") or a literal hex colour. */
const colourRef = z.string().min(1, 'must name a palette colour or give a hex value');

const semanticModeSchema = z
  .object({
    bg: colourRef,
    surface: colourRef,
    'text-primary': colourRef,
    'text-secondary': colourRef,
    brand: colourRef,
    action: colourRef,
    'on-action': colourRef,
    link: colourRef,
    border: colourRef,
    positive: colourRef,
    negative: colourRef,
    forecast: colourRef,
    series: z.array(colourRef).min(1, 'needs at least one chart series colour').max(8),
  })
  .strict();

const typeScaleSchema = z
  .object({
    display: z.number().positive(),
    heading: z.number().positive(),
    subheading: z.number().positive(),
    body: z.number().positive(),
    label: z.number().positive(),
  })
  .strict();

const clientSchema = z
  .object({
    name: z.string().min(1).nullable(),
    appName: z.string().min(1).nullable(),
    appShortName: z
      .string()
      .min(1)
      .max(12, 'short names must be 12 characters or fewer')
      .nullable(),
    logo: z.string().min(1).nullable(),
    logoOnDark: z.string().min(1).nullable(),
    icons: z.array(z.string().min(1)),
    favicon: z.string().min(1).nullable(),
  })
  .strict();

/**
 * Schema for a fully merged theme (base + client overrides). The base theme in
 * `themes/foresite/tokens.json` must satisfy this on its own.
 */
export const themeTokensSchema = z
  .object({
    $description: z.string().optional(),
    client: clientSchema,
    palette: z.record(z.string().min(1), hexColour),
    semantic: z.object({ light: semanticModeSchema, dark: semanticModeSchema }).strict(),
    rules: z.array(z.string()).optional(),
    type: z
      .object({
        sans: z.string().min(1),
        mono: z.string().min(1),
        scale: typeScaleSchema,
        labelStyle: z.string().optional(),
      })
      .strict(),
    credit: z.string().min(1),
  })
  .strict();

export type ThemeTokens = z.infer<typeof themeTokensSchema>;
export type SemanticModeTokens = z.infer<typeof semanticModeSchema>;
export type TypeScale = z.infer<typeof typeScaleSchema>;

/** Semantic colours with every reference resolved to a hex value. */
export type ResolvedColours = Record<SemanticKey, string> & { series: string[] };

export interface ResolvedTheme {
  /** Theme folder name under `themes/`. */
  slug: string;
  /** Absolute path of the theme folder the overrides came from. */
  dir: string;
  /** Client (or Foresite) display names. */
  name: string;
  appName: string;
  appShortName: string;
  credit: string;
  palette: Record<string, string>;
  colours: Record<ThemeMode, ResolvedColours>;
  type: { sans: string; mono: string; scale: TypeScale; labelStyle?: string };
  /** Asset file names relative to `dir`; null means "not supplied, use a placeholder". */
  assets: {
    logo: string | null;
    logoOnDark: string | null;
    icons: string[];
    favicon: string | null;
  };
  rules: string[];
}
