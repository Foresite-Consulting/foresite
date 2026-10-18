/* Foresite service worker.
 *
 * What it caches (and nothing else):
 *   1. The /offline page and the static chunks it references, at install.
 *   2. /_next/static/* files as they are requested. These are content-hashed
 *      and immutable, so cache-first is safe. When the offline page's assets
 *      change (a new build), every other static entry is dropped, and at most
 *      MAX_STATIC_ENTRIES are kept at any time (oldest first out).
 *
 * What it never caches: API routes (/api/*), anything under /auth, any
 * non-GET request, and any other page. Pages are always fetched from the
 * network and returned as they come, error statuses included; only when the
 * network itself fails is the cached /offline page served, and the offline
 * page shows the last numbers kept on this device. /offline is stored only if
 * it really is that document (200, HTML, final URL /offline, not a redirect
 * target), so it must stay public and free of personal data.
 *
 * Bump CACHE_VERSION when the caching rules change; old caches are removed on
 * activate.
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME = `foresite-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline';
const STATIC_PREFIX = '/_next/static/';
const NEVER_CACHE_PREFIXES = ['/api/', '/auth'];
/** Most /_next/static/ entries kept at once. The offline page's own assets are never evicted. */
const MAX_STATIC_ENTRIES = 60;
/** Internal record of which static assets the cached offline page references. Never served. */
const OFFLINE_ASSETS_KEY = '/__foresite-sw/offline-assets.json';

let offlineRefreshed = false;

/** Path plus query, the form used as a cache key throughout. */
function cacheKey(url) {
  const parsed = new URL(url, self.location.origin);
  return parsed.pathname + parsed.search;
}

/**
 * True only for the real offline page: a 200 HTML document, fetched without
 * any redirect, whose final URL is exactly /offline on this origin. If /offline
 * ever redirects (for example to a sign-in page, or through a hop that lands
 * back on /offline), the response is not stored as the offline page.
 */
function isOfflineDocument(response) {
  if (response.status !== 200 || response.redirected !== false) return false;
  let finalUrl;
  try {
    finalUrl = new URL(response.url);
  } catch {
    return false;
  }
  if (finalUrl.origin !== self.location.origin || finalUrl.pathname !== OFFLINE_URL) return false;
  const type = (response.headers.get('Content-Type') || '').toLowerCase();
  return type.startsWith('text/html');
}

async function readOfflineAssets(cache) {
  const record = await cache.match(OFFLINE_ASSETS_KEY);
  if (!record) return null;
  try {
    const list = await record.json();
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : null;
  } catch {
    return null;
  }
}

/**
 * Keep the static cache bounded. With `dropUnreferenced`, every static entry
 * the current offline page does not reference is removed (used when a new
 * build is detected, so the old build's chunks go). Otherwise the oldest
 * unreferenced entries (insertion order) go until at most MAX_STATIC_ENTRIES
 * remain.
 */
async function pruneStaticAssets(cache, keep, dropUnreferenced) {
  const requests = await cache.keys();
  const statics = requests.filter((request) =>
    new URL(request.url).pathname.startsWith(STATIC_PREFIX),
  );
  const unreferenced = statics.filter((request) => !keep.has(cacheKey(request.url)));
  const referencedCount = statics.length - unreferenced.length;
  const removable = dropUnreferenced
    ? unreferenced
    : unreferenced.slice(
        0,
        Math.max(0, unreferenced.length - Math.max(0, MAX_STATIC_ENTRIES - referencedCount)),
      );
  await Promise.all(removable.map((request) => cache.delete(request)));
}

/** Fetch the offline page and the static chunks its HTML references. */
async function cacheOfflinePage() {
  const cache = await caches.open(CACHE_NAME);
  const response = await fetch(OFFLINE_URL, { cache: 'no-store', credentials: 'same-origin' });
  if (!isOfflineDocument(response)) {
    throw new Error(
      `Offline page not stored: status ${response.status}, redirected ${response.redirected}, url ${response.url || '(none)'}`,
    );
  }
  await cache.put(OFFLINE_URL, response.clone());

  const html = await response.text();
  const urls = new Set();
  // Stop at quotes, whitespace and backslashes (URLs inside escaped JSON in the RSC payload).
  const pattern = /["'](\/_next\/static\/[^"'\s\\]+)["'\\]/g;
  let match;
  while ((match = pattern.exec(html)) !== null) urls.add(cacheKey(match[1]));
  await Promise.all(
    [...urls].map(async (url) => {
      if (await cache.match(url)) return;
      const asset = await fetch(url, { credentials: 'same-origin' });
      if (asset.ok) await cache.put(url, asset);
    }),
  );

  // A different set of offline assets means a new build: drop the old build's
  // chunks. With no record (first run, or an upgrade from v1) do the same.
  const previous = await readOfflineAssets(cache);
  const changed =
    previous === null || previous.length !== urls.size || previous.some((url) => !urls.has(url));
  await cache.put(
    OFFLINE_ASSETS_KEY,
    new Response(JSON.stringify([...urls]), { headers: { 'Content-Type': 'application/json' } }),
  );
  await pruneStaticAssets(cache, urls, changed);
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
  // A network failure rejects here, exactly as it would with no worker.
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache
      .put(request, response.clone())
      .then(async () => {
        const keep = new Set(await readOfflineAssets(cache));
        await pruneStaticAssets(cache, keep, false);
      })
      .catch(() => undefined);
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
