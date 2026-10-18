import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Runs public/sw.js inside a fake service-worker global so its caching rules
 * can be tested without a browser.
 */

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  request: Request;
  waitUntil: (promise: Promise<unknown>) => void;
  respondWith: (response: Promise<Response> | Response) => void;
}

class FakeCache {
  store = new Map<string, Response>();
  async match(request: Request | string) {
    const key = typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
    const hit = this.store.get(key);
    return hit ? hit.clone() : undefined;
  }
  async put(request: Request | string, response: Response) {
    const key = typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
    this.store.set(key, response);
  }
  async delete(request: Request | string) {
    const key = typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
    return this.store.delete(key);
  }
  async keys() {
    return [...this.store.keys()].map((url) => new Request(url));
  }
  paths() {
    return [...this.store.keys()].map((url) => {
      const parsed = new URL(url);
      return parsed.pathname + parsed.search;
    });
  }
}

const ORIGIN = 'https://venue.example';

function load() {
  const caches = new Map<string, FakeCache>();
  const cacheStorage = {
    async open(name: string) {
      let cache = caches.get(name);
      if (!cache) {
        cache = new FakeCache();
        caches.set(name, cache);
      }
      return cache;
    },
    async keys() {
      return [...caches.keys()];
    },
    async delete(name: string) {
      return caches.delete(name);
    },
    async match(request: Request | string) {
      for (const cache of caches.values()) {
        const hit = await cache.match(request);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const listeners = new Map<string, Listener[]>();
  const self = {
    location: new URL(ORIGIN),
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };

  const fetchMock = vi.fn<(input: Request | string, init?: RequestInit) => Promise<Response>>();
  const source = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'caches', 'fetch', 'URL', 'Response', source)(
    self,
    cacheStorage,
    fetchMock,
    URL,
    Response,
  );

  async function dispatch(type: 'install' | 'activate' | 'fetch', request?: Request) {
    const pending: Promise<unknown>[] = [];
    let responded: Promise<Response> | Response | undefined;
    const event: FakeEvent = {
      request: request ?? new Request(ORIGIN),
      waitUntil: (promise) => pending.push(promise),
      respondWith: (response) => {
        responded = response;
      },
    };
    for (const listener of listeners.get(type) ?? []) listener(event);
    await Promise.all(pending);
    return responded === undefined ? undefined : await responded;
  }

  return { caches, cacheStorage, fetchMock, self, dispatch };
}

const offlineHtml =
  '<html><script src="/_next/static/chunks/offline-abc.js"></script><link href="/_next/static/css/app-1.css"></html>';

/** Node's Request rejects mode "navigate", so fake it on top of a real Request. */
function navigate(path: string): Request {
  return Object.create(new Request(`${ORIGIN}${path}`), {
    mode: { value: 'navigate' },
  }) as Request;
}

/** A Response as fetch would return it, with its final URL set (Node's constructor cannot). */
function fetched(response: Response, url: string, redirected = false): Response {
  Object.defineProperty(response, 'url', { value: new URL(url, ORIGIN).href });
  Object.defineProperty(response, 'redirected', { value: redirected });
  return response;
}

function html(body: string, url: string, status = 200) {
  return fetched(
    new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    url,
  );
}

const CACHE = 'foresite-v2';

describe('service worker', () => {
  let sw: ReturnType<typeof load>;

  beforeEach(() => {
    sw = load();
    sw.fetchMock.mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
      if (url.pathname === '/offline') return html(offlineHtml, url.href);
      if (url.pathname.startsWith('/_next/static/'))
        return fetched(new Response('asset'), url.href);
      if (url.pathname === '/api/health') return fetched(Response.json({ status: 'ok' }), url.href);
      return html('<html>page</html>', url.href);
    });
  });

  it('precaches the offline page and the chunks it references on install', async () => {
    await sw.dispatch('install');
    const cache = sw.caches.get(CACHE);
    expect(cache).toBeDefined();
    const keys = (await cache!.keys()).map((r) => new URL(r.url).pathname);
    expect(keys).toEqual(
      expect.arrayContaining([
        '/offline',
        '/_next/static/chunks/offline-abc.js',
        '/_next/static/css/app-1.css',
      ]),
    );
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });

  it('removes old caches on activate', async () => {
    await sw.cacheStorage.open('foresite-v0');
    await sw.cacheStorage.open('foresite-v1');
    await sw.cacheStorage.open('other-app');
    await sw.dispatch('activate');
    expect(await sw.cacheStorage.keys()).toEqual(['other-app']);
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });

  it('serves pages from the network and never caches them', async () => {
    await sw.dispatch('install');
    const request = navigate('/');
    const response = await sw.dispatch('fetch', request);
    expect(await response!.text()).toBe('<html>page</html>');
    const keys = (await sw.caches.get(CACHE)!.keys()).map((r) => new URL(r.url).pathname);
    expect(keys).not.toContain('/');
  });

  it('falls back to the cached offline page when a navigation fails', async () => {
    await sw.dispatch('install');
    sw.fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const response = await sw.dispatch('fetch', navigate('/'));
    expect(response!.status).toBe(200);
    expect(await response!.text()).toBe(offlineHtml);
  });

  it('answers 503 when nothing is cached and the network is down', async () => {
    sw.fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const response = await sw.dispatch('fetch', navigate('/'));
    expect(response!.status).toBe(503);
  });

  it('leaves API, auth, non-GET and cross-origin requests alone', async () => {
    for (const request of [
      new Request(`${ORIGIN}/api/health`),
      new Request(`${ORIGIN}/api/ingest/counters/milesight`),
      new Request(`${ORIGIN}/api/ingest/counters/milesight`, { method: 'POST', body: '{}' }),
      new Request(`${ORIGIN}/auth/callback`),
      new Request(`${ORIGIN}/`, { method: 'POST' }),
      new Request('https://other.example/_next/static/x.js'),
    ]) {
      expect(await sw.dispatch('fetch', request)).toBeUndefined();
    }
    expect(sw.fetchMock).not.toHaveBeenCalled();
  });

  it('serves hashed static assets cache-first', async () => {
    const request = new Request(`${ORIGIN}/_next/static/chunks/a.js`);
    await sw.dispatch('fetch', request);
    expect(sw.fetchMock).toHaveBeenCalledTimes(1);
    const again = await sw.dispatch('fetch', new Request(`${ORIGIN}/_next/static/chunks/a.js`));
    expect(await again!.text()).toBe('asset');
    expect(sw.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a non-OK page response as it is, not the offline page', async () => {
    await sw.dispatch('install');
    sw.fetchMock.mockResolvedValue(html('<html>server error</html>', `${ORIGIN}/`, 500));
    const response = await sw.dispatch('fetch', navigate('/'));
    expect(response!.status).toBe(500);
    expect(await response!.text()).toBe('<html>server error</html>');
  });

  it('lets a failed static fetch fail as it would without a worker, and caches nothing', async () => {
    sw.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const url = `${ORIGIN}/_next/static/chunks/b.js`;
    await expect(sw.dispatch('fetch', new Request(url))).rejects.toThrow('Failed to fetch');
    expect(await sw.cacheStorage.match(url)).toBeUndefined();
    // The next attempt, online, is fetched and cached as usual.
    expect(await (await sw.dispatch('fetch', new Request(url)))!.text()).toBe('asset');
  });

  it('does not store /offline when it redirects somewhere else', async () => {
    sw.fetchMock.mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
      if (url.pathname === '/offline') {
        // e.g. a future auth layer bouncing /offline to sign-in.
        return fetched(
          new Response('<html>Sign in, Jane</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
          `${ORIGIN}/sign-in?next=/offline`,
          true,
        );
      }
      return fetched(new Response('asset'), url.href);
    });
    await expect(sw.dispatch('install')).rejects.toThrow(/Offline page not stored/);
    expect(await sw.cacheStorage.match('/offline')).toBeUndefined();
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('does not store /offline when a redirect lands back on /offline', async () => {
    sw.fetchMock.mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
      if (url.pathname === '/offline') {
        // Final URL is exactly /offline, but it got there via a redirect hop.
        return fetched(
          new Response(offlineHtml, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
          `${ORIGIN}/offline`,
          true,
        );
      }
      return fetched(new Response('asset'), url.href);
    });
    await expect(sw.dispatch('install')).rejects.toThrow(
      /Offline page not stored.*redirected true/,
    );
    expect(await sw.cacheStorage.match('/offline')).toBeUndefined();
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('does not store /offline unless it is a 200 HTML document', async () => {
    for (const response of [
      html('<html>oops</html>', '/offline', 500),
      fetched(Response.json({ not: 'html' }), '/offline'),
    ]) {
      const fresh = load();
      fresh.fetchMock.mockResolvedValue(response);
      await expect(fresh.dispatch('install')).rejects.toThrow(/Offline page not stored/);
      expect(await fresh.cacheStorage.match('/offline')).toBeUndefined();
    }
  });

  it("drops the old build's static files when the offline page changes", async () => {
    await sw.dispatch('install');
    const cache = sw.caches.get(CACHE)!;
    // A chunk from the previous build, cached while browsing.
    await cache.put('/_next/static/chunks/old-build-123.js', new Response('old'));
    expect(cache.paths()).toContain('/_next/static/chunks/old-build-123.js');

    // New deploy: the offline page now references a new chunk.
    const newHtml = '<html><script src="/_next/static/chunks/offline-def.js"></script></html>';
    sw.fetchMock.mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
      if (url.pathname === '/offline') return html(newHtml, url.href);
      if (url.pathname.startsWith('/_next/static/'))
        return fetched(new Response('asset'), url.href);
      return html('<html>page</html>', url.href);
    });
    // The first successful navigation refreshes the offline page.
    await sw.dispatch('fetch', navigate('/'));
    await vi.waitFor(() => {
      expect(cache.paths()).toContain('/_next/static/chunks/offline-def.js');
      expect(cache.paths()).not.toContain('/_next/static/chunks/old-build-123.js');
    });
    expect(cache.paths()).not.toContain('/_next/static/chunks/offline-abc.js');
    expect(cache.paths()).toContain('/offline');
  });

  it('keeps runtime-cached chunks while the build is unchanged', async () => {
    await sw.dispatch('install');
    await sw.dispatch('fetch', new Request(`${ORIGIN}/_next/static/chunks/page-a.js`));
    const cache = sw.caches.get(CACHE)!;
    await vi.waitFor(() => {
      expect(cache.paths()).toContain('/_next/static/chunks/page-a.js');
    });
    // Same offline page again (worker restarted, first navigation): nothing dropped.
    await sw.dispatch('fetch', navigate('/'));
    const offlineFetches = () =>
      sw.fetchMock.mock.calls.filter(([input]) => input === '/offline').length;
    await vi.waitFor(() => {
      expect(offlineFetches()).toBe(2);
    });
    // Let the background refresh (put, record, prune) run to completion.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.paths()).toContain('/_next/static/chunks/page-a.js');
    expect(cache.paths()).toContain('/_next/static/chunks/offline-abc.js');
  });

  it('caps the static cache at 60 entries, oldest first, never evicting offline assets', async () => {
    await sw.dispatch('install');
    const cache = sw.caches.get(CACHE)!;
    for (let i = 0; i < 70; i += 1) {
      await sw.dispatch('fetch', new Request(`${ORIGIN}/_next/static/chunks/c${i}.js`));
      // Let each fire-and-forget put + prune finish before the next request.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await vi.waitFor(() => {
      const statics = cache.paths().filter((p) => p.startsWith('/_next/static/'));
      expect(statics).toHaveLength(60);
    });
    const statics = cache.paths().filter((p) => p.startsWith('/_next/static/'));
    expect(statics).toContain('/_next/static/chunks/offline-abc.js');
    expect(statics).toContain('/_next/static/css/app-1.css');
    expect(statics).not.toContain('/_next/static/chunks/c0.js');
    expect(statics).toContain('/_next/static/chunks/c69.js');
  });
});
