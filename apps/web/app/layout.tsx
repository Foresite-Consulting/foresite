import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { RegisterServiceWorker } from '@/components/RegisterServiceWorker';
import { fontClassNames } from '@/lib/fonts';
import { getTheme, getThemeCss } from '@/lib/theme';
import './globals.css';

export function generateMetadata(): Metadata {
  const theme = getTheme();
  // Browser tab and home-screen icons: never the maskable one (it has no safe-zone crop there).
  const plainIcons = theme.assets.icons.filter((icon) => icon.purpose !== 'maskable');
  const appleIcon =
    plainIcons.find((icon) => icon.sizes.split(' ').includes('192x192')) ?? plainIcons[0];
  return {
    title: {
      default: theme.appName,
      template: `%s · ${theme.appName}`,
    },
    description: `${theme.appName}: today's numbers and what's coming, for the people running the venue.`,
    applicationName: theme.appName,
    appleWebApp: { capable: true, title: theme.appShortName, statusBarStyle: 'default' },
    formatDetection: { telephone: false },
    icons: {
      icon: plainIcons.map((icon) => ({ url: `/theme-assets/${icon.src}`, sizes: icon.sizes })),
      apple: appleIcon !== undefined ? [{ url: `/theme-assets/${appleIcon.src}` }] : [],
    },
  };
}

export function generateViewport(): Viewport {
  const theme = getTheme();
  return {
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
    themeColor: [
      { media: '(prefers-color-scheme: light)', color: theme.colours.light.bg },
      { media: '(prefers-color-scheme: dark)', color: theme.colours.dark.bg },
    ],
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = getTheme();
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html lang="en-AU" className={fontClassNames(theme)} suppressHydrationWarning>
      <head>
        {/* Theme tokens as CSS variables; generated from themes/<slug>/tokens.json. */}
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: getThemeCss() }} />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-3"
        >
          Skip to content
        </a>
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
