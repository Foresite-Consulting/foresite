import type { MetadataRoute } from 'next';
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
    icons: theme.assets.icons.map((file) => ({
      src: `/theme-assets/${file}`,
      sizes: file.includes('512') ? '512x512' : '192x192',
      type: 'image/png',
      purpose: file.includes('maskable') ? 'maskable' : 'any',
    })),
  };
}
