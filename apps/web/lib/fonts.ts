import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import type { ResolvedTheme } from '@foresite/ui/theme';

/**
 * Web fonts are self-hosted by next/font at build time (no request to Google
 * at runtime). next/font needs each family named statically, so this registry
 * lists the families themes may ask for; `type.sans` / `type.mono` in the
 * theme pick from it. A family not listed here falls back to the system stack
 * named in the theme CSS, with a build-time warning.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-loaded-sans',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-loaded-mono',
});

const sansFonts: Record<string, { variable: string }> = {
  'IBM Plex Sans': plexSans,
};

const monoFonts: Record<string, { variable: string }> = {
  'IBM Plex Mono': plexMono,
};

/** Font families already warned about, so the warning prints once per process, not per render. */
const warned = new Set<string>();

function warnUnregistered(slug: string, family: string): void {
  if (warned.has(family)) return;
  warned.add(family);
  console.warn(
    `Theme "${slug}" asks for the font "${family}", which is not registered in apps/web/lib/fonts.ts. Using the system fallback.`,
  );
}

/** Class names to put on `<html>` so the theme's `--font-loaded-*` variables resolve. */
export function fontClassNames(theme: ResolvedTheme): string {
  const sans = sansFonts[theme.type.sans];
  const mono = monoFonts[theme.type.mono];
  if (sans === undefined) warnUnregistered(theme.slug, theme.type.sans);
  if (mono === undefined) warnUnregistered(theme.slug, theme.type.mono);
  return [sans?.variable, mono?.variable].filter((v): v is string => v !== undefined).join(' ');
}
