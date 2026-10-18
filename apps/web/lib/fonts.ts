import localFont from 'next/font/local';
import type { ResolvedTheme } from '@foresite/ui/theme';

/**
 * Web fonts are committed to the repo (`apps/web/app/fonts/`, latin subset,
 * SIL OFL 1.1) and served from our own origin by next/font/local, so neither
 * the build nor the browser contacts Google. next/font needs each family named
 * statically, so this registry lists the families themes may ask for;
 * `type.sans` / `type.mono` in the theme pick from it. A family not listed here
 * falls back to the system stack named in the theme CSS, with a build-time
 * warning.
 */
const plexSans = localFont({
  src: [
    { path: '../app/fonts/ibm-plex-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../app/fonts/ibm-plex-sans-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: '../app/fonts/ibm-plex-sans-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-loaded-sans',
});

const plexMono = localFont({
  src: [
    { path: '../app/fonts/ibm-plex-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../app/fonts/ibm-plex-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
  ],
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
