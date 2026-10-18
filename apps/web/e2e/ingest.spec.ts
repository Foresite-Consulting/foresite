import { expect, test, type APIRequestContext, type TestInfo } from '@playwright/test';
import { basicAuth, floorToMinutes, milesightPeriodic } from '../test/ingest-helpers';
import { E2E_RATE_CAPACITY, e2eDeviceId } from './ingest-env';

/**
 * Device ingest against the production build (`next start`, NODE_ENV=production).
 * Synthetic Milesight payloads only. Each project and retry has its own
 * devices, and each test picks its own interval times, so reruns never see
 * each other's readings.
 */

const PATH = '/api/ingest/counters/milesight';
const SECRET = process.env.E2E_INGEST_SECRET ?? '';
/** What Vercel's edge adds in production. `next start` alone would say http. */
const HTTPS = { 'x-forwarded-proto': 'https' };

function deviceFor(info: TestInfo, role: 'main' | 'replay' | 'limit') {
  return e2eDeviceId(info.project.name, role, Math.min(info.retry, 1));
}

/** A run-unique base interval, a few days back, aligned to 5 minutes. */
function baseStart(): Date {
  const daysBack = 2 + Math.floor(Math.random() * 20);
  const minutesBack = Math.floor(Math.random() * 1_000) * 5;
  return floorToMinutes(new Date(Date.now() - daysBack * 86_400_000 - minutesBack * 60_000), 5);
}

function slot(base: Date, n: number): Date {
  return new Date(base.getTime() + n * 5 * 60_000);
}

function send(
  request: APIRequestContext,
  deviceId: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return request.post(PATH, {
    headers: {
      ...HTTPS,
      'content-type': 'application/json',
      authorization: basicAuth(deviceId, SECRET),
      ...headers,
    },
    // A Buffer is sent byte for byte; Playwright would JSON-encode a string
    // that is not valid JSON.
    data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

test.beforeAll(() => {
  expect(SECRET, 'E2E_INGEST_SECRET is set by playwright.config.ts').not.toBe('');
});

test.describe('counter ingest', () => {
  test('accepts a reading (201), then reports the re-send as a duplicate (200)', async ({
    request,
  }, info) => {
    const device = deviceFor(info, 'main');
    const body = milesightPeriodic({ start: baseStart() });
    const first = await send(request, device, body);
    expect(first.status()).toBe(201);
    expect(await first.json()).toMatchObject({ status: 'ok', accepted: 1, duplicate: 0, late: 1 });
    const headers = first.headers();
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['content-security-policy']).toBeUndefined();
    expect(headers['x-content-type-options']).toBe('nosniff');

    const again = await send(request, device, body);
    expect(again.status()).toBe(200);
    expect(await again.json()).toMatchObject({ accepted: 0, duplicate: 1 });
  });

  test('rejects bad payloads with 400 and a safe code', async ({ request }, info) => {
    const device = deviceFor(info, 'main');
    const notJson = await send(request, device, '{"device_info":');
    expect(notJson.status()).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'invalid_json' });

    const wrongShape = await send(request, device, { hello: 'MARKER-e2e' });
    expect(wrongShape.status()).toBe(400);
    const text = await wrongShape.text();
    expect(text).toBe('{"error":"invalid_payload"}');
  });

  test('answers 401 with a Basic challenge for bad credentials', async ({ request }, info) => {
    const device = deviceFor(info, 'main');
    const body = milesightPeriodic({ start: baseStart() });
    for (const authorization of [
      basicAuth(device, `${SECRET}x`),
      basicAuth('e2e-no-such-device', SECRET),
      'Bearer nope',
    ]) {
      const response = await send(request, device, body, { authorization });
      expect(response.status()).toBe(401);
      expect(response.headers()['www-authenticate']).toContain('Basic realm=');
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
    const missing = await request.post(PATH, {
      headers: { ...HTTPS, 'content-type': 'application/json' },
      data: JSON.stringify(body),
    });
    expect(missing.status()).toBe(401);
  });

  test('answers 413 for an oversized body and 415 for the wrong content type', async ({
    request,
  }, info) => {
    const device = deviceFor(info, 'main');
    const big = await send(request, device, JSON.stringify({ pad: 'x'.repeat(70_000) }));
    expect(big.status()).toBe(413);
    expect(await big.json()).toEqual({ error: 'payload_too_large' });

    const plain = await send(request, device, '{}', { 'content-type': 'text/plain' });
    expect(plain.status()).toBe(415);
    expect(await plain.json()).toEqual({ error: 'unsupported_media_type' });
  });

  test('refuses plain HTTP in production, unknown providers and other methods', async ({
    request,
  }, info) => {
    const device = deviceFor(info, 'main');
    const http = await request.post(PATH, {
      headers: { 'content-type': 'application/json', authorization: basicAuth(device, SECRET) },
      data: '{}',
    });
    expect(http.status()).toBe(403);
    expect(await http.json()).toEqual({ error: 'https_required' });

    const unknown = await request.post('/api/ingest/counters/acme', {
      headers: { ...HTTPS, 'content-type': 'application/json' },
      data: '{}',
    });
    expect(unknown.status()).toBe(404);

    const get = await request.get(PATH);
    expect(get.status()).toBe(405);
  });

  test('replay: the same 3 intervals twice plus an overlapping outage backfill never double count', async ({
    request,
  }, info) => {
    const device = deviceFor(info, 'replay');
    const base = baseStart();
    const live = [0, 1, 2].map((n) =>
      milesightPeriodic({
        start: slot(base, n),
        lines: [{ line: 1, in: 10 + n, out: n, capacity: 3 }],
      }),
    );
    for (const body of live) expect((await send(request, device, body)).status()).toBe(201);
    for (const body of live) {
      const replay = await send(request, device, body);
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toMatchObject({ accepted: 0, duplicate: 1, conflict: 0 });
    }
    // After an outage the device sends intervals 1 to 4: 1 and 2 overlap, 3 and 4 are new.
    const backfill = [1, 2, 3, 4].map((n) =>
      milesightPeriodic({
        start: slot(base, n),
        lines: [{ line: 1, in: 10 + n, out: n, capacity: 3 }],
      }),
    );
    const response = await send(request, device, backfill);
    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({ accepted: 2, duplicate: 2, conflict: 0 });
    // Totals: 3 live + 2 new = 5 readings, each stored once (3 + 3 + 2 accepted, rest duplicates).
  });

  test('rate-limits a device with 429 and Retry-After', async ({ request }, info) => {
    const device = deviceFor(info, 'limit');
    const base = baseStart();
    const statuses: number[] = [];
    let retryAfter: string | undefined;
    for (let n = 0; n < E2E_RATE_CAPACITY + 3; n += 1) {
      const response = await send(request, device, milesightPeriodic({ start: slot(base, n) }));
      statuses.push(response.status());
      if (response.status() === 429) retryAfter = response.headers()['retry-after'];
    }
    expect(statuses.slice(0, E2E_RATE_CAPACITY).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(E2E_RATE_CAPACITY)).toEqual([429, 429, 429]);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});
