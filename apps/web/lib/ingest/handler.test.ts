import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { basicAuth, floorToMinutes, milesightPeriodic } from '../../test/ingest-helpers';
import { DEFAULT_CLOCK_POLICY } from './clock';
import { handleCounterIngest, type IngestDeps } from './handler';
import type { IngestLogEntry } from './log';
import { MemoryIngestRepository } from './memory-repository';
import { MemoryTokenBucket } from './rate-limit';
import type { DeviceRecord, IngestRepository } from './repository';
import { generateDeviceSecret, hashDeviceSecret } from './secrets';

const NOW = Date.parse('2026-10-18T11:07:00.000Z');
const SECRET = generateDeviceSecret();
const URL_BASE = 'https://ingest.example/api/ingest/counters/milesight';
let secretHash: string;

beforeAll(async () => {
  secretHash = await hashDeviceSecret(SECRET);
});

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    provider: 'milesight',
    deviceId: 'door-01',
    venueId: 'venue-test',
    entryPointId: 'front',
    lineEntryPoints: {},
    vendorSerial: 'TEST0000000001',
    active: true,
    secretHashes: [secretHash],
    ...overrides,
  };
}

interface Setup {
  repo: MemoryIngestRepository;
  deps: IngestDeps;
  logs: IngestLogEntry[];
}

function setup(overrides: Partial<IngestDeps> = {}, devices = [device()]): Setup {
  const repo = new MemoryIngestRepository(devices);
  const logs: IngestLogEntry[] = [];
  const deps: IngestDeps = {
    repository: repo,
    deviceLimiter: new MemoryTokenBucket({ capacity: 100, refillPerSecond: 10, now: () => NOW }),
    authFailureLimiter: new MemoryTokenBucket({
      capacity: 5,
      refillPerSecond: 5 / 60,
      now: () => NOW,
    }),
    clock: DEFAULT_CLOCK_POLICY,
    maxBodyBytes: 65_536,
    requireHttps: true,
    now: () => NOW,
    logger: (entry) => logs.push(entry),
    ...overrides,
  };
  return { repo, deps, logs };
}

interface PostOptions {
  body?: unknown;
  raw?: BodyInit;
  auth?: string | null;
  contentType?: string | null;
  proto?: string | null;
  headers?: Record<string, string>;
  provider?: string;
}

function post(s: Setup, options: PostOptions = {}) {
  const headers = new Headers(options.headers);
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (contentType !== null) headers.set('content-type', contentType);
  const auth = options.auth === undefined ? basicAuth('door-01', SECRET) : options.auth;
  if (auth !== null) headers.set('authorization', auth);
  const proto = options.proto === undefined ? 'https' : options.proto;
  if (proto !== null) headers.set('x-forwarded-proto', proto);
  const body =
    options.raw ?? JSON.stringify(options.body ?? milesightPeriodic({ start: intervalStart(0) }));
  const request = new Request(URL_BASE, {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as RequestInit);
  return handleCounterIngest(request, options.provider ?? 'milesight', s.deps);
}

/** Start of the n-th 5-minute interval before "now" (0 = the one that just ended). */
function intervalStart(n: number): Date {
  return new Date(floorToMinutes(new Date(NOW), 5).getTime() - (n + 1) * 5 * 60_000);
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe('POST /api/ingest/counters/[provider]: happy path', () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  it('stores a periodic report and answers 201 with counts', async () => {
    const response = await post(s);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await json(response)).toEqual({
      status: 'ok',
      accepted: 1,
      duplicate: 0,
      conflict: 0,
      rejected: 0,
      late: 0,
      ignored: 0,
    });
    const [reading] = await s.repo.listReadings('door-01');
    expect(reading).toMatchObject({
      entryPointId: 'front',
      intervalStart: intervalStart(0).toISOString(),
      countIn: 5,
      countOut: 2,
      occupancy: 3,
      flag: null,
    });
    expect(s.logs.at(-1)).toMatchObject({
      outcome: 'stored',
      status: 201,
      deviceId: 'door-01',
      secretSlot: 1,
    });
  });

  it('answers 200 with a duplicate count when the device re-sends', async () => {
    await post(s);
    const again = await post(s);
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ accepted: 0, duplicate: 1 });
  });

  it('records a conflict when the same interval comes back with different counts', async () => {
    await post(s);
    const changed = await post(s, {
      body: milesightPeriodic({ start: intervalStart(0), lines: [{ line: 1, in: 9, out: 2 }] }),
    });
    expect(changed.status).toBe(200);
    expect(await json(changed)).toMatchObject({ accepted: 0, conflict: 1 });
    expect((await s.repo.listReadings('door-01'))[0]).toMatchObject({ countIn: 9, revision: 2 });
    const events = await s.repo.listEvents('door-01');
    expect(events.filter((e) => e.type === 'reading_conflict')).toHaveLength(1);
  });

  it('replays: the same 3 intervals twice plus an overlapping backfill never double count', async () => {
    const live = [2, 1, 0].map((n, i) =>
      milesightPeriodic({ start: intervalStart(n), lines: [{ line: 1, in: 10 + i, out: i }] }),
    );
    for (const body of live) expect((await post(s, { body })).status).toBe(201);
    for (const body of live) {
      const replay = await post(s, { body });
      expect(replay.status).toBe(200);
      expect(await json(replay)).toMatchObject({ accepted: 0, duplicate: 1 });
    }
    // Outage backfill: five intervals, the last three of which are already stored.
    const backfill = [4, 3, 2, 1, 0].map((n, i) =>
      milesightPeriodic({
        start: intervalStart(n),
        lines: [{ line: 1, in: i < 2 ? 20 + i : 10 + (i - 2), out: i < 2 ? 0 : i - 2 }],
      }),
    );
    const response = await post(s, { body: backfill });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ accepted: 2, duplicate: 3, conflict: 0 });

    const stored = await s.repo.listReadings('door-01');
    expect(stored).toHaveLength(5);
    expect(stored.reduce((sum, r) => sum + r.countIn, 0)).toBe(20 + 21 + 10 + 11 + 12);
    expect(stored.reduce((sum, r) => sum + r.countOut, 0)).toBe(0 + 0 + 0 + 1 + 2);
  });

  it('keeps two lines on separate entry points', async () => {
    const two = setup({}, [device({ lineEntryPoints: { '2': 'side' } })]);
    const response = await post(two, {
      body: milesightPeriodic({
        start: intervalStart(0),
        lines: [
          { line: 1, in: 3, out: 1 },
          { line: 2, in: 4, out: 0 },
        ],
      }),
    });
    expect(await json(response)).toMatchObject({ accepted: 2 });
    expect((await two.repo.listReadings('door-01')).map((r) => r.entryPointId).sort()).toEqual([
      'front',
      'side',
    ]);
  });

  it('refuses with 400 a report whose lines land on one entry point, storing nothing (review F1)', async () => {
    // Line 2 mapped onto the device's own entry point, which line 1 uses.
    const clash = setup({}, [device({ lineEntryPoints: { '2': 'front' } })]);
    const response = await post(clash, {
      body: milesightPeriodic({
        start: intervalStart(0),
        lines: [
          { line: 1, in: 3, out: 1 },
          { line: 2, in: 4, out: 0 },
        ],
      }),
    });
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'duplicate_entry_point' });
    expect(await clash.repo.listReadings('door-01')).toEqual([]);
    const events = await clash.repo.listEvents('door-01');
    expect(events.map((e) => [e.type, e.detail.error_code])).toEqual([
      ['payload_rejected', 'duplicate_entry_point'],
    ]);
  });

  it('accepts trigger reports without turning them into readings', async () => {
    const response = await post(s, {
      body: {
        device_info: { device_sn: 'TEST0000000001' },
        line_trigger_data: [{ line: 1, in: 1, out: 0 }],
        time_info: { time: '2026-10-18T19:06:00+08:00' },
      },
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ accepted: 0, ignored: 1 });
    expect(await s.repo.listReadings('door-01')).toEqual([]);
  });

  it('records an occlusion alarm as an event', async () => {
    await post(s, {
      body: {
        device_info: { device_sn: 'TEST0000000001' },
        time_info: { time: '2026-10-18T19:06:00+08:00' },
        tof_occlusion_trigger: { device_sn: 'TEST0000000001', occlusion_status: 'occluded' },
      },
    });
    const alarms = (await s.repo.listEvents('door-01')).filter((e) => e.type === 'device_alarm');
    expect(alarms.map((e) => e.detail)).toEqual([{ alarm: 'occlusion', status: 'occluded' }]);
  });

  it('accepts either secret during rotation', async () => {
    const next = generateDeviceSecret();
    const rotating = setup({}, [
      device({ secretHashes: [secretHash, await hashDeviceSecret(next)] }),
    ]);
    expect((await post(rotating)).status).toBe(201);
    const second = await post(rotating, {
      auth: basicAuth('door-01', next),
      body: milesightPeriodic({ start: intervalStart(1) }),
    });
    expect(second.status).toBe(201);
    expect(rotating.logs.at(-1)?.secretSlot).toBe(2);
  });

  it('accepts application/json with a UTF-8 charset', async () => {
    expect((await post(s, { contentType: 'application/json; charset=UTF-8' })).status).toBe(201);
  });
});

describe('clock sanity', () => {
  it('flags old buffered data as late and still stores it', async () => {
    const s = setup();
    const response = await post(s, { body: milesightPeriodic({ start: intervalStart(12) }) });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ accepted: 1, late: 1 });
    expect((await s.repo.listReadings('door-01'))[0]?.flag).toBe('late');
  });

  it('rejects intervals from the future or older than the window, but answers 200 so the device moves on', async () => {
    const s = setup();
    const future = milesightPeriodic({ start: new Date(NOW + 20 * 60_000) });
    const ancient = milesightPeriodic({ start: new Date(NOW - 31 * 86_400_000) });
    const response = await post(s, { body: [future, ancient] });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ accepted: 0, rejected: 2 });
    const reasons = (await s.repo.listEvents('door-01'))
      .filter((e) => e.type === 'reading_rejected_clock')
      .map((e) => e.detail.reason);
    expect(reasons).toEqual(['future', 'too_old']);
  });
});

describe('refusals', () => {
  it('requires HTTPS in production', async () => {
    const s = setup();
    for (const proto of [null, 'http', 'http, https']) {
      const response = await post(s, { proto });
      expect(response.status).toBe(403);
      expect(await json(response)).toEqual({ error: 'https_required' });
    }
    expect((await post(s, { proto: 'https, http' })).status).toBe(201);
    const local = setup({ requireHttps: false });
    expect((await post(local, { proto: null })).status).toBe(201);
  });

  it('answers 404 for providers it does not know', async () => {
    const s = setup();
    for (const provider of ['acme', 'status', '__proto__', 'MILESIGHT']) {
      const response = await post(s, { provider });
      expect(response.status).toBe(404);
      expect(await json(response)).toEqual({ error: 'unknown_provider' });
    }
  });

  it('answers 415 unless the body is declared as JSON', async () => {
    const s = setup();
    for (const contentType of [
      null,
      'text/plain',
      'application/x-www-form-urlencoded',
      'application/json; charset=latin1',
      'application/jsonp',
    ]) {
      const response = await post(s, { contentType });
      expect(response.status, String(contentType)).toBe(415);
      expect(await json(response)).toEqual({ error: 'unsupported_media_type' });
    }
  });

  it('answers 413 for bodies over the cap, declared or streamed', async () => {
    const s = setup({ maxBodyBytes: 1_024 });
    const big = JSON.stringify({ pad: 'x'.repeat(2_000) });
    const declared = await post(s, { raw: big, headers: { 'content-length': String(big.length) } });
    expect(declared.status).toBe(413);
    // Declared length is checked before authentication.
    const declaredNoAuth = await post(s, {
      raw: big,
      auth: null,
      headers: { 'content-length': String(big.length) },
    });
    expect(declaredNoAuth.status).toBe(413);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i += 1) controller.enqueue(encoder.encode('x'.repeat(200)));
        controller.close();
      },
    });
    const streamed = await post(s, { raw: stream });
    expect(streamed.status).toBe(413);
    expect(await json(streamed)).toEqual({ error: 'payload_too_large' });
  });

  it('answers 401 with no detail for every kind of bad credential', async () => {
    const s = setup({}, [device(), device({ deviceId: 'door-off', active: false })]);
    const attempts = [
      null,
      'Bearer token',
      basicAuth('door-01', `${SECRET}x`),
      basicAuth('door-99', SECRET),
      basicAuth('door-off', SECRET),
    ];
    const bodies = new Set<string>();
    for (const auth of attempts) {
      const response = await post(s, {
        auth,
        headers: { 'x-real-ip': `198.51.100.${bodies.size + 1}` },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        'Basic realm="Foresite counter ingest", charset="UTF-8"',
      );
      bodies.add(await response.text());
    }
    expect([...bodies]).toEqual(['{"error":"unauthorized"}']);
    expect(await s.repo.listEvents('door-01')).toEqual([]);
  });

  it('slows down repeated failed logins from one address before running scrypt', async () => {
    const s = setup();
    const from = { 'x-real-ip': '203.0.113.7' };
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await post(s, { auth: basicAuth('door-01', 'wrong-secret-123456'), headers: from }))
          .status,
      ).toBe(401);
    }
    const throttled = await post(s, {
      auth: basicAuth('door-01', 'wrong-secret-123456'),
      headers: from,
    });
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another address is unaffected.
    expect((await post(s, { headers: { 'x-real-ip': '203.0.113.8' } })).status).toBe(201);
  });

  it('answers 429 with Retry-After when a device exceeds its rate', async () => {
    const s = setup({
      deviceLimiter: new MemoryTokenBucket({ capacity: 2, refillPerSecond: 0.1, now: () => NOW }),
    });
    expect((await post(s)).status).toBe(201);
    expect((await post(s)).status).toBe(200);
    const limited = await post(s);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('10');
    expect(await json(limited)).toEqual({ error: 'rate_limited' });
  });

  it('answers 400 with a safe code for bad JSON and bad payloads, never echoing input', async () => {
    const s = setup();
    const cases: [BodyInit, string][] = [
      ['', 'invalid_json'],
      ['{"device_info":', 'invalid_json'],
      [new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), 'invalid_json'],
      [JSON.stringify({ hello: 'MARKER-123' }), 'invalid_payload'],
      [
        JSON.stringify({
          device_info: { device_sn: 'TEST0000000001' },
          time_info: { end_time: 'MARKER-123' },
          line_periodic_data: [{ line: 1, in: 1, out: 1 }],
        }),
        'missing_interval',
      ],
    ];
    for (const [raw, code] of cases) {
      const response = await post(s, { raw });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toBe(JSON.stringify({ error: code }));
    }
    expect(JSON.stringify(s.logs)).not.toContain('MARKER-123');
    const rejected = (await s.repo.listEvents('door-01')).filter(
      (e) => e.type === 'payload_rejected',
    );
    expect(rejected.map((e) => e.detail.error_code)).toEqual([
      'invalid_payload',
      'missing_interval',
    ]);
  });

  it('refuses a payload from a different serial than the device registered', async () => {
    const s = setup();
    const response = await post(s, {
      body: milesightPeriodic({ start: intervalStart(0), serial: 'TEST0000000999' }),
    });
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: 'device_mismatch' });
    expect(await s.repo.listReadings('door-01')).toEqual([]);
    const unpinned = setup({}, [device({ vendorSerial: null })]);
    expect(
      (
        await post(unpinned, {
          body: milesightPeriodic({ start: intervalStart(0), serial: 'TEST0000000999' }),
        })
      ).status,
    ).toBe(201);
  });

  it('answers 503 when storage is not configured or fails, so the device retries later', async () => {
    const none = setup({ repository: null });
    const response = await post(none);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');

    const failing = setup();
    const broken: IngestRepository = {
      findDevice: (p, d) => failing.repo.findDevice(p, d),
      ingest: () => Promise.reject(new Error('connection reset')),
      rejectPayload: () => Promise.reject(new Error('connection reset')),
      recordEvent: () => Promise.reject(new Error('connection reset')),
      listReadings: () => Promise.resolve([]),
      listEvents: () => Promise.resolve([]),
    };
    failing.deps.repository = broken;
    const failed = await post(failing);
    expect(failed.status).toBe(503);
    expect(await json(failed)).toEqual({ error: 'storage_unavailable' });

    const lookupFails = setup();
    lookupFails.deps.repository = {
      ...broken,
      findDevice: () => Promise.reject(new Error('down')),
    };
    expect((await post(lookupFails)).status).toBe(503);
  });
});

describe('logging', () => {
  it('never logs secrets, credentials, payload values or unauthenticated device ids', async () => {
    const s = setup();
    await post(s);
    await post(s, { auth: basicAuth('door-77', SECRET) });
    await post(s, { auth: basicAuth(SECRET, 'whatever-secret') });
    await post(s, { raw: '{"bad":' });
    const text = JSON.stringify(s.logs);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('door-77');
    expect(text).not.toContain('TEST0000000001');
    expect(text).not.toMatch(/authorization|basic /i);
    for (const entry of s.logs) {
      expect(
        Object.keys(entry).every((k) =>
          [
            'provider',
            'outcome',
            'status',
            'deviceId',
            'secretSlot',
            'errorCode',
            'paths',
            'counts',
            'reportTypes',
            'durationMs',
            'requestId',
          ].includes(k),
        ),
      ).toBe(true);
    }
    expect(s.logs.map((l) => l.outcome)).toEqual([
      'stored',
      'auth_unknown_device',
      'auth_unknown_device',
      'invalid_json',
    ]);
  });
});
