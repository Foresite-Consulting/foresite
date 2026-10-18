import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ZodError } from 'zod';
import {
  HEX_PATTERN,
  SEMANTIC_KEYS,
  THEME_MODES,
  themeTokensSchema,
  type ResolvedColours,
  type ResolvedTheme,
  type ThemeMode,
  type ThemeTokens,
} from './schema';

export const BASE_THEME_SLUG = 'foresite';
export const THEME_ENV_VAR = 'NEXT_PUBLIC_THEME';

/** Theme folder names: lower-case letters, digits, hyphens and underscores only. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Thrown for any theme problem. The message is written for a developer reading build output. */
export class ThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeError';
  }
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge `overlay` onto `base`. Objects merge recursively; arrays and
 * primitives in the overlay replace the base value; `null` in the overlay means
 * "no override, fall back to the base". Neither input is mutated.
 */
export function mergeTokens(base: JsonObject, overlay: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null || value === undefined) continue;
    const current = out[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = mergeTokens(current, value);
    } else if (isPlainObject(value)) {
      out[key] = mergeTokens({}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function formatZodError(error: ZodError, file: string): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  return `Theme file ${file} is not valid:\n${lines.join('\n')}`;
}

function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ThemeError(
      `Could not read theme file ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ThemeError(
      `Theme file ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Find the repo's `themes/` directory by walking up from `start`. Works from the
 * repo root, from `apps/web` (where `next build` runs) and from any package.
 */
export function findThemesDir(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, 'themes');
    if (existsSync(join(candidate, BASE_THEME_SLUG, 'tokens.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ThemeError(
    `Could not find a themes/ folder containing ${BASE_THEME_SLUG}/tokens.json above ${resolve(start)}.`,
  );
}

function listThemeSlugs(themesDir: string): string[] {
  return readdirSync(themesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
}

function resolveColour(
  ref: string,
  palette: Record<string, string>,
  where: string,
  file: string,
): string {
  if (HEX_PATTERN.test(ref)) return ref.toUpperCase();
  const hex = palette[ref];
  if (hex === undefined) {
    const known = Object.keys(palette).sort().join(', ');
    throw new ThemeError(
      `Theme file ${file}: ${where} refers to palette colour "${ref}", which is not defined. ` +
        `Known palette colours: ${known}.`,
    );
  }
  return hex.toUpperCase();
}

function resolveMode(tokens: ThemeTokens, mode: ThemeMode, file: string): ResolvedColours {
  const source = tokens.semantic[mode];
  const resolved: Partial<Record<(typeof SEMANTIC_KEYS)[number], string>> = {};
  for (const key of SEMANTIC_KEYS) {
    resolved[key] = resolveColour(source[key], tokens.palette, `semantic.${mode}.${key}`, file);
  }
  const series = source.series.map((ref, index) =>
    resolveColour(ref, tokens.palette, `semantic.${mode}.series[${index}]`, file),
  );
  return { ...(resolved as Record<(typeof SEMANTIC_KEYS)[number], string>), series };
}

/** Validate merged tokens and resolve every colour reference to hex. */
export function resolveTheme(
  raw: unknown,
  { slug, dir, file }: { slug: string; dir: string; file: string },
): ResolvedTheme {
  const parsed = themeTokensSchema.safeParse(raw);
  if (!parsed.success) throw new ThemeError(formatZodError(parsed.error, file));
  const tokens = parsed.data;

  const colours = {} as Record<ThemeMode, ResolvedColours>;
  for (const mode of THEME_MODES) colours[mode] = resolveMode(tokens, mode, file);

  const name = tokens.client.name ?? 'Foresite';
  const appName = tokens.client.appName ?? name;
  const appShortName = tokens.client.appShortName ?? appName.slice(0, 12);

  return {
    slug,
    dir,
    name,
    appName,
    appShortName,
    credit: tokens.credit,
    palette: Object.fromEntries(
      Object.entries(tokens.palette).map(([key, hex]) => [key, hex.toUpperCase()]),
    ),
    colours,
    type: {
      sans: tokens.type.sans,
      mono: tokens.type.mono,
      scale: tokens.type.scale,
      ...(tokens.type.labelStyle !== undefined ? { labelStyle: tokens.type.labelStyle } : {}),
    },
    assets: {
      logo: tokens.client.logo,
      logoOnDark: tokens.client.logoOnDark,
      icons: tokens.client.icons,
      favicon: tokens.client.favicon,
    },
    rules: tokens.rules ?? [],
  };
}

export interface LoadThemeOptions {
  /** Theme folder under `themes/`. Defaults to `NEXT_PUBLIC_THEME`, then "foresite". */
  slug?: string | undefined;
  /** Absolute path of the `themes/` folder. Found automatically by default. */
  themesDir?: string | undefined;
}

/**
 * Load the active theme: the Foresite base tokens with a client theme merged on
 * top. Throws `ThemeError` with a clear message on any problem, so a bad theme
 * fails the build instead of shipping a half-branded app.
 */
export function loadTheme(options: LoadThemeOptions = {}): ResolvedTheme {
  const envSlug = process.env[THEME_ENV_VAR];
  const slug =
    options.slug ?? (envSlug !== undefined && envSlug !== '' ? envSlug : BASE_THEME_SLUG);
  if (!SLUG_PATTERN.test(slug)) {
    throw new ThemeError(
      `${THEME_ENV_VAR}="${slug}" is not a valid theme name. Use lower-case letters, digits, hyphens and underscores.`,
    );
  }

  const themesDir = options.themesDir ?? findThemesDir();
  const baseFile = join(themesDir, BASE_THEME_SLUG, 'tokens.json');
  const base = readJsonFile(baseFile);
  if (!isPlainObject(base))
    throw new ThemeError(`Theme file ${baseFile} must contain a JSON object.`);

  if (slug === BASE_THEME_SLUG) {
    return resolveTheme(base, { slug, dir: join(themesDir, slug), file: baseFile });
  }

  const dir = join(themesDir, slug);
  const file = join(dir, 'tokens.json');
  if (!existsSync(file)) {
    const available = listThemeSlugs(themesDir).join(', ');
    throw new ThemeError(
      `Theme "${slug}" (${THEME_ENV_VAR}) has no ${file}. Available themes: ${available}. ` +
        `Copy themes/_client-template/ to themes/${slug}/ to create it.`,
    );
  }
  const overlay = readJsonFile(file);
  if (!isPlainObject(overlay))
    throw new ThemeError(`Theme file ${file} must contain a JSON object.`);

  return resolveTheme(mergeTokens(base, overlay), { slug, dir, file });
}
