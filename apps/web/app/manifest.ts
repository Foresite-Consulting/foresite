import type { MetadataRoute } from 'next';
import { themeAssetContentType } from '@foresite/ui/theme';
import { getTheme } from '@/lib/theme';

export const dynamic = 'force-static';

/** Web app manifest built from the active theme, so the installed app carries the client's name and colours. */
export default function manifest(): MetadataRoute.Manifest {
  const theme = getTheme();
  return {
    name: theme.appName,
    short_name: theme.appShortName,
    description: `${theme.appName}: today's numbers and what's coming.`,
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    lang: 'en-AU',
    dir: 'ltr',
    background_color: theme.colours.light.bg,
    theme_color: theme.colours.light.bg,
    // Sizes and purpose come from the theme as declared, never from file names.
    icons: theme.assets.icons.map((icon) => ({
      src: `/theme-assets/${icon.src}`,
      sizes: icon.sizes,
      purpose: icon.purpose ?? 'any',
      type: themeAssetContentType(icon.src),
    })),
  };
}
