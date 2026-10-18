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

/**
 * File types a theme may supply for its logo, icons and favicon, with the
 * Content-Type `/theme-assets/<file>` serves them as.
 */
export const THEME_ASSET_CONTENT_TYPES = {
  png: 'image/png',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  webp: 'image/webp',
} as const;

export type ThemeAssetExtension = keyof typeof THEME_ASSET_CONTENT_TYPES;

/** Content-Type for a theme asset file name, or undefined if the extension is not allowed. */
export function themeAssetContentType(file: string): string | undefined {
  const extension = file.split('.').pop()?.toLowerCase() ?? '';
  return Object.hasOwn(THEME_ASSET_CONTENT_TYPES, extension)
    ? THEME_ASSET_CONTENT_TYPES[extension as ThemeAssetExtension]
    : undefined;
}

/**
 * A file directly inside the theme folder: no slashes, no leading dot, and one
 * of the allowed extensions, so a bad theme fails at load time rather than
 * when the asset is first requested.
 */
const assetFile = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    'must be a file name in the theme folder (letters, digits, ".", "_", "-"; no slashes)',
  )
  .refine((file) => themeAssetContentType(file) !== undefined, {
    message: `must end in ${Object.keys(THEME_ASSET_CONTENT_TYPES)
      .map((ext) => `.${ext}`)
      .join(', ')}`,
  });

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
    logo: assetFile.nullable(),
    logoOnDark: assetFile.nullable(),
    icons: z.array(assetFile),
    favicon: assetFile.nullable(),
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
