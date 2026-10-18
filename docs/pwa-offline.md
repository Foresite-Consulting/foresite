# PWA and offline behaviour

The app installs from `/manifest.webmanifest`, which `apps/web/app/manifest.ts` builds from the active theme (name, short name, colours, icons). Icons, logo and favicon are served from `themes/<slug>/` by `/theme-assets/<file>`; only files the theme declares are served, only as PNG, SVG, ICO or WebP (the theme schema rejects other extensions at load time), and every response carries `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-origin`, so an SVG opened directly cannot run script.

## What the service worker caches

`apps/web/public/sw.js` is registered in production builds only (`components/RegisterServiceWorker.tsx`).

| Request                              | Rule                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/offline` and the chunks it needs   | Precached at install. Refreshed once per worker lifetime after the first successful page load, so a deploy brings a fresh copy. Stored only if the response is a 200 HTML document whose final URL is exactly `/offline` (a redirect target is never stored). |
| `/_next/static/*`                    | Cache-first. These files are content-hashed and immutable. When the offline page's asset list changes (a new build), every other static entry is dropped; at most 60 static entries are kept at any time, oldest out first, never the offline page's own.     |
| Page navigations (`/`, `/offline` …) | Network-first, never stored, returned as they come (a 500 stays a 500). Only if the network fails is the cached `/offline` page served.                                                                                                                       |
| `/api/*`, `/auth*`                   | Never touched by the worker. No caching of data or auth responses.                                                                                                                                                                                            |
| Non-GET, cross-origin                | Never touched by the worker.                                                                                                                                                                                                                                  |

**`/offline` must stay public and free of personal data.** The worker stores its HTML for every visitor of the device, so it must never require sign-in, never vary by user and never put a person's details or the venue's trading figures in its HTML (the theme's app name and logo are fine). Its numbers come only from the device's own snapshot, read in the browser (below). If an auth layer ever redirects `/offline`, the worker refuses to store it rather than caching the sign-in page.

Caches are named `foresite-<version>` (now `v2`); bump `CACHE_VERSION` in `sw.js` when the rules change and old caches are deleted on activate. `/sw.js` is served with `Cache-Control: no-cache` so browsers pick up a new worker on the next visit.

## "Showing the last numbers we had"

The worker never caches dashboard HTML, because that would keep sales figures in the HTTP cache. Instead the dashboard page writes the snapshot it rendered (tile labels, formatted values, the `updatedAt` time and timezone) to `localStorage` under `foresite.lastSnapshot.v1`. The offline page reads it, validates its shape, and shows the tiles with "Last updated 18 Oct 2026, 2:05 pm AWST".

Open question for the auth PR: clear the snapshot on sign-out (`forgetSnapshot()` in `components/RememberSnapshot.tsx`) and decide whether wage-related tiles may be kept on the device at all.

## Testing

- `apps/web/test/sw.test.ts` runs `sw.js` in a fake worker environment and checks every rule above, including the offline fallback.
- `apps/web/e2e/smoke.spec.ts` checks the real worker installs, precaches `/offline` and never stores `/api/*` responses. Playwright cannot take a service worker offline, so the fallback itself is covered by the unit test.
