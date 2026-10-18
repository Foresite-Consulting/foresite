import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { basicAuth, floorToMinutes, milesightPeriodic } from '../../test/ingest-helpers';
import { DEFAULT_CLOCK_POLICY } from './clock';
import { handleCounterIngest, type IngestDeps } from './handler';
import { checkJsonSafety, MAX_JSON_DEPTH } from './json-safety';
import type { IngestLogEntry } from './log';
import { createMigratedPglite, fromPglite, seedDevice } from './pglite';
import { PostgresIngestRepository } from './postgres-repository';
import { MemoryTokenBucket } from './rate-limit';
import type { DeviceRecord } from './repository';
import { generateDeviceSecret, hashDeviceSecret } from './secrets';

/**
 * Attacker-controlled input must never produce a 5xx (review F4, F7). These
 * run against the real schema in PGlite, because the failures in question
 * (jsonb refusing a string, a RangeError while serialising) only show up at
 * the store.
 */

const NOW = Date.parse('2026-10-18T11:07:00.000Z');
const SECRET = generateDeviceSecret();
let db: PGlite;
let deps: IngestDeps;
const logs: IngestLogEntry[] = [];

const start = new Date(floorToMinutes(new Date(NOW), 5).getTime() - 5 * 60_000);

beforeAll(async () => {
  db = await createMigratedPglite();
  const client = fromPglite(db);
  const device: DeviceRecord = {
    provider: 'milesight',
    deviceId: 'door-01',
    venueId: 'venue-test',
    entryPointId: 'front',
    lineEntryPoints: {},
    vendorSerial: 'TEST0000000001',
    active: true,
    secretHashes: [await hashDeviceSecret(SECRET)],
  };
  await seedDevice(client, device);
  deps = {
    repository: new PostgresIngestRepository(client),
    deviceLimiter: new MemoryTokenBucket({ capacity: 1_000, refillPerSecond: 100 }),
    authFailureLimiter: new MemoryTokenBucket({ capacity: 1_000, refillPerSecond: 100 }),
    clock: DEFAULT_CLOCK_POLICY,
    maxBodyBytes: 65_536,
    requireHttps: false,
    now: () => NOW,
    logger: (entry) => logs.push(entry),
  };
}, 60_000);

afterAll(async () => {
  await db.close();
});

function post(raw: BodyInit) {
  return handleCounterIngest(
    new Request('http://ingest.test/api/ingest/counters/milesight', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basicAuth('door-01', SECRET) },
      body: raw,
    }),
    'milesight',
    deps,
  );
}

/** A valid periodic report with `extra` merged in at the top level. */
function reportWith(extra: string): string {
  const base = JSON.stringify(milesightPeriodic({ start }));
  return `${base.slice(0, -1)},${extra}}`;
}

describe('checkJsonSafety', () => {
  it('measures depth by containers and walks without recursion', () => {
    expect(checkJsonSafety(1)).toBeNull();
    expect(
      checkJsonSafety(JSON.parse('['.repeat(MAX_JSON_DEPTH) + ']'.repeat(MAX_JSON_DEPTH))),
    ).toBeNull();
    expect(
      checkJsonSafety(JSON.parse('['.repeat(MAX_JSON_DEPTH + 1) + ']'.repeat(MAX_JSON_DEPTH + 1))),
    ).toBe('too_deep');
    expect(checkJsonSafety(JSON.parse('['.repeat(30_000) + ']'.repeat(30_000)))).toBe('too_deep');
  });

  it('refuses strings jsonb cannot hold, in keys and values', () => {
    expect(checkJsonSafety({ a: 'x\u0000y' })).toBe('unsupported_string');
    expect(checkJsonSafety({ 'k\u0000': 1 })).toBe('unsupported_string');
    expect(checkJsonSafety(['\uD800'])).toBe('unsupported_string');
    expect(checkJsonSafety(['a\uDC00'])).toBe('unsupported_string');
    expect(checkJsonSafety(['emoji 😀 ok', 'é', '\u0001'])).toBeNull();
  });
});

describe('hostile bodies get a 4xx, never a 5xx', () => {
  it('refuses 30,000 levels of nesting with 400 invalid_json (the reviewer’s case)', async () => {
    const response = await post('['.repeat(30_000) + ']'.repeat(30_000));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });

  it('refuses deep nesting inside an otherwise valid report', async () => {
    const deep = '{"a":'.repeat(40) + '1' + '}'.repeat(40);
    const response = await post(reportWith(`"region_data":${deep}`));
    expect(response.status).toBe(400);
  });

  it.each([
    ['NUL in a value', '"device_name_extra":"a\\u0000b"'],
    ['NUL in a key', '"k\\u0000":1'],
    ['unpaired high surrogate', '"x":"\\ud800"'],
    ['unpaired low surrogate', '"x":"\\udfff"'],
  ])('refuses %s with 400 invalid_json', async (_name, extra) => {
    const response = await post(reportWith(extra));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });

  it('answers below 500 for a spread of awkward bodies', async () => {
    const bodies = [
      reportWith('"big":1e400'),
      reportWith('"neg":-0'),
      reportWith('"__proto__":{"polluted":true}'),
      reportWith('"constructor":{"prototype":{"x":1}}'),
      reportWith(`"wide":[${Array.from({ length: 5_000 }, () => '0').join(',')}]`),
      reportWith(`"keys":{${Array.from({ length: 2_000 }, (_, i) => `"k${i}":${i}`).join(',')}}`),
      reportWith('"emoji":"\\ud83d\\ude00"'),
      JSON.stringify(Array.from({ length: 101 }, () => milesightPeriodic({ start }))),
      JSON.stringify([]),
      'null',
      '"just a string"',
      '1e400',
      JSON.stringify({
        ...milesightPeriodic({ start }),
        time_info: { start_time: 'x', end_time: 'y' },
      }),
      JSON.stringify({
        ...milesightPeriodic({ start }),
        time_info: {
          start_time: '9999-12-31T23:55:00+14:00',
          end_time: '9999-12-31T23:59:59+14:00',
        },
      }),
      JSON.stringify({
        ...milesightPeriodic({ start }),
        time_info: {
          start_time: '0001-01-01T00:00:00+00:00',
          end_time: '0001-01-01T00:05:00+00:00',
        },
      }),
    ];
    for (const body of bodies) {
      const response = await post(body);
      expect(response.status, body.slice(0, 80)).toBeLessThan(500);
    }
  });
});

describe('client abort mid-body (review F7)', () => {
  let server: Server;
  let port: number;
  const serverLogs: IngestLogEntry[] = [];
  const done: Promise<Response>[] = [];

  beforeAll(async () => {
    // A plain Node server in front of the handler, as Next.js does.
    server = createServer((req, res) => {
      const controller = new AbortController();
      req.on('close', () => {
        controller.abort();
      });
      const request = new Request(`http://127.0.0.1${req.url ?? '/'}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
        duplex: 'half',
        signal: controller.signal,
      } as RequestInit);
      const handled = handleCounterIngest(request, 'milesight', {
        ...deps,
        logger: (entry) => serverLogs.push(entry),
      });
      done.push(handled);
      void handled.then(
        async (response) => {
          if (!res.destroyed) res.writeHead(response.status).end(await response.text());
        },
        () => {
          if (!res.destroyed) res.writeHead(500).end();
        },
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('answers 400 body_aborted with a request id, logged as a warning, not internal_error', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          [
            'POST /api/ingest/counters/milesight HTTP/1.1',
            'Host: 127.0.0.1',
            'Content-Type: application/json',
            `Authorization: ${basicAuth('door-01', SECRET)}`,
            'Content-Length: 60000',
            '',
            '{"device_info":{"device_sn":"TEST',
          ].join('\r\n'),
        );
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 300);
      });
      socket.on('error', reject);
    });
    await expect.poll(() => done.length, { timeout: 5_000 }).toBe(1);
    const response = await done[0]!;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'body_aborted' });
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(serverLogs).toHaveLength(1);
    expect(serverLogs[0]).toMatchObject({
      outcome: 'body_aborted',
      status: 400,
      errorCode: 'body_aborted',
      deviceId: 'door-01',
    });
    expect(serverLogs[0]!.requestId).toBe(response.headers.get('x-request-id'));
  });
});
