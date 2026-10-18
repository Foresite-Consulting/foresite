import 'server-only';
import { loadTheme, themeToCss, type ResolvedTheme } from '@foresite/ui/theme';

let cached: { theme: ResolvedTheme; css: string } | undefined;

/**
 * The active theme, loaded once per server process from `themes/`. A bad theme
 * throws `ThemeError`, which fails `next build` with the message in the log.
 */
export function getTheme(): ResolvedTheme {
  return getThemeBundle().theme;
}

export function getThemeCss(): string {
  return getThemeBundle().css;
}

function getThemeBundle(): { theme: ResolvedTheme; css: string } {
  if (cached === undefined) {
    const theme = loadTheme();
    cached = { theme, css: themeToCss(theme) };
  }
  return cached;
}
