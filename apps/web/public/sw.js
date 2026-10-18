/* Foresite service worker.
 *
 * What it caches (and nothing else):
 *   1. The /offline page and the static chunks it references, at install.
 *   2. /_next/static/* files as they are requested. These are content-hashed
 *      and immutable, so cache-first is safe.
 *
 * What it never caches: API routes (/api/*), anything under /auth, any
 * non-GET request, and any other page. Pages are always fetched from the
 * network; if that fails, the cached /offline page is served instead, and the
 * offline page shows the last numbers kept on this device.
 *
 * Bump CACHE_VERSION when the caching rules change; old caches are removed on
 * activate.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `foresite-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline';
const STATIC_PREFIX = '/_next/static/';
const NEVER_CACHE_PREFIXES = ['/api/', '/auth'];

let offlineRefreshed = false;

/** Fetch the offline page and the static chunks its HTML references. */
async function cacheOfflinePage() {
  const cache = await caches.open(CACHE_NAME);
  const response = await fetch(OFFLINE_URL, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Offline page returned ${response.status}`);
  await cache.put(OFFLINE_URL, response.clone());

  const html = await response.text();
  const urls = new Set();
  const pattern = /["'](\/_next\/static\/[^"'\s]+)["']/g;
  let match;
  while ((match = pattern.exec(html)) !== null) urls.add(match[1]);
  await Promise.all(
    [...urls].map(async (url) => {
      if (await cache.match(url)) return;
      const asset = await fetch(url, { credentials: 'same-origin' });
      if (asset.ok) await cache.put(url, asset);
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheOfflinePage().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('foresite-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function isNeverCached(url) {
  return NEVER_CACHE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    // Pick up a fresh offline page after each deploy, once per worker lifetime.
    if (!offlineRefreshed && response.ok) {
      offlineRefreshed = true;
      cacheOfflinePage().catch(() => {
        offlineRefreshed = false;
      });
    }
    return response;
  } catch {
    const cached = await caches.match(OFFLINE_URL);
    if (cached) return cached;
    return new Response("You're offline and no offline page is saved yet.", {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function handleStaticAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCached(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (url.pathname.startsWith(STATIC_PREFIX)) {
    event.respondWith(handleStaticAsset(request));
  }
  // Everything else goes straight to the network, uncached.
});
