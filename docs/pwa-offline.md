# PWA and offline behaviour

The app installs from `/manifest.webmanifest`, which `apps/web/app/manifest.ts` builds from the active theme (name, short name, colours, icons). Icons, logo and favicon are served from `themes/<slug>/` by `/theme-assets/<file>`; only files the theme declares are served.

## What the service worker caches

`apps/web/public/sw.js` is registered in production builds only (`components/RegisterServiceWorker.tsx`).

| Request                              | Rule                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `/offline` and the chunks it needs   | Precached at install. Refreshed once per worker lifetime after the first successful page load, so a deploy brings a fresh copy. |
| `/_next/static/*`                    | Cache-first. These files are content-hashed and immutable.                                                                      |
| Page navigations (`/`, `/offline` …) | Network-first, never stored. If the network fails, the cached `/offline` page is served.                                        |
| `/api/*`, `/auth*`                   | Never touched by the worker. No caching of data or auth responses.                                                              |
| Non-GET, cross-origin                | Never touched by the worker.                                                                                                    |

Caches are named `foresite-<version>`; bump `CACHE_VERSION` in `sw.js` when the rules change and old caches are deleted on activate. `/sw.js` is served with `Cache-Control: no-cache` so browsers pick up a new worker on the next visit.

## "Showing the last numbers we had"

The worker never caches dashboard HTML, because that would keep sales figures in the HTTP cache. Instead the dashboard page writes the snapshot it rendered (tile labels, formatted values, the `updatedAt` time and timezone) to `localStorage` under `foresite.lastSnapshot.v1`. The offline page reads it, validates its shape, and shows the tiles with "Last updated 18 Oct 2026, 2:05 pm AWST".

Open question for the auth PR: clear the snapshot on sign-out (`forgetSnapshot()` in `components/RememberSnapshot.tsx`) and decide whether wage-related tiles may be kept on the device at all.

## Testing

- `apps/web/test/sw.test.ts` runs `sw.js` in a fake worker environment and checks every rule above, including the offline fallback.
- `apps/web/e2e/smoke.spec.ts` checks the real worker installs, precaches `/offline` and never stores `/api/*` responses. Playwright cannot take a service worker offline, so the fallback itself is covered by the unit test.
