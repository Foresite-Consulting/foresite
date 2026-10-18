import { BuiltByCredit } from '@foresite/ui';
import type { ReactNode } from 'react';
import type { ResolvedTheme } from '@foresite/ui/theme';

/**
 * Header, content column and footer. The header shows the client's logo when
 * the theme supplies one and a text wordmark otherwise.
 */
export function AppShell({ theme, children }: { theme: ResolvedTheme; children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between gap-4 py-4">
        <AppWordmark theme={theme} />
      </header>
      <main id="main" className="flex-1 pb-8">
        {children}
      </main>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-4">
        <BuiltByCredit credit={theme.credit} />
        <a href="/offline" className="inline-flex min-h-tap items-center text-label">
          Offline view
        </a>
      </footer>
    </div>
  );
}

function AppWordmark({ theme }: { theme: ResolvedTheme }) {
  if (theme.assets.logo !== null) {
    const onDark = theme.assets.logoOnDark ?? theme.assets.logo;
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element -- theme assets are small files served by our own route. */}
        <img
          src={`/theme-assets/${theme.assets.logo}`}
          alt={theme.appName}
          className="h-8 w-auto dark:hidden"
          height={32}
        />
        {/* eslint-disable-next-line @next/next/no-img-element -- as above. */}
        <img
          src={`/theme-assets/${onDark}`}
          alt={theme.appName}
          className="hidden h-8 w-auto dark:block"
          height={32}
        />
      </>
    );
  }
  // TODO(brand): replace with the Foresite logo from the Brand Guidelines v1.0
  // logo masters (held by the Brand & Design agent in the Foresite Project).
  // Never redraw the logo from memory.
  return (
    <p className="flex items-center gap-2 text-body font-semibold tracking-tight">
      <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full bg-brand" />
      {theme.appName}
    </p>
  );
}
