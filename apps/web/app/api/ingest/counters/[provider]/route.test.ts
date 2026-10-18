import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { basicAuth, floorToMinutes, milesightPeriodic } from '@/test/ingest-helpers';
import { generateDeviceSecret, hashDeviceSecret } from '@/lib/ingest/secrets';

/** Wiring: the route builds its dependencies from the environment. */

const secret = generateDeviceSecret();
let POST: typeof import('./route').POST;
const saved = { ...process.env };

beforeAll(async () => {
  process.env.INGEST_STORAGE = 'memory';
  process.env.INGEST_MEMORY_DEVICES = JSON.stringify([
    {
      provider: 'milesight',
      deviceId: 'route-dev',
      venueId: 'venue-route',
      entryPointId: 'front',
      secretHashes: [await hashDeviceSecret(secret)],
    },
  ]);
  vi.resetModules();
  ({ POST } = await import('./route'));
});

afterAll(() => {
  process.env = saved;
});

function call(provider: string, auth: string, body: unknown) {
  const request = new Request(`http://localhost/api/ingest/counters/${provider}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ provider }) });
}

describe('route /api/ingest/counters/[provider]', () => {
  it('declares a Node runtime and no caching', async () => {
    const route = await import('./route');
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    expect(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k))).toEqual(['POST']);
  });

  it('stores a reading for a device configured in the environment', async () => {
    const start = new Date(floorToMinutes(new Date(), 5).getTime() - 5 * 60_000);
    const response = await call(
      'milesight',
      basicAuth('route-dev', secret),
      milesightPeriodic({ start }),
    );
    expect(response.status).toBe(201);
    expect((await call('milesight', basicAuth('route-dev', 'wrong-secret-0000'), {})).status).toBe(
      401,
    );
    expect((await call('nope', basicAuth('route-dev', secret), {})).status).toBe(404);
  });
});
