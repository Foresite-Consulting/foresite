import { describe, expect, it } from 'vitest';
import { getCounterAdapter, hashPayload, resolveEntryPointId } from '../index';
import type { CounterDeviceContext, CounterMapInput, CounterMapOutcome } from '../types';
import occlusion from './fixtures/occlusion-alarm.json';
import periodic from './fixtures/periodic-line.json';
import twoLines from './fixtures/periodic-two-lines.json';
import triggerLine from './fixtures/trigger-line.json';
import triggerRegion from './fixtures/trigger-region.json';
import { mapMilesightPayload } from './map';

const device: CounterDeviceContext = {
  provider: 'milesight',
  deviceId: 'fs-test-door-01',
  venueId: 'venue-test',
  entryPointId: 'front-door',
  lineEntryPoints: {},
  vendorSerial: 'TEST0000000001',
};

const RECEIVED_AT = '2026-10-17T11:05:03.000Z';
const HASH = 'a'.repeat(64);

function map(body: unknown, overrides: Partial<CounterDeviceContext> = {}): CounterMapOutcome {
  const input: CounterMapInput = {
    body,
    device: { ...device, ...overrides },
    receivedAt: RECEIVED_AT,
    rawPayloadHash: HASH,
  };
  return mapMilesightPayload(input);
}

function ok(outcome: CounterMapOutcome) {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.code}`);
  return outcome.value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('Milesight periodic line report', () => {
  it('maps one line to a vendor-neutral reading in UTC', () => {
    const result = ok(map(periodic));
    expect(result.reportTypes).toEqual(['line_periodic', 'region_periodic']);
    expect(result.vendorSerials).toEqual(['TEST0000000001']);
    expect(result.readings).toEqual([
      {
        provider: 'milesight',
        deviceId: 'fs-test-door-01',
        venueId: 'venue-test',
        entryPointId: 'front-door',
        sourceLine: '1',
        intervalStart: '2026-10-17T11:00:00.000Z',
        intervalEnd: '2026-10-17T11:05:00.000Z',
        countIn: 12,
        countOut: 7,
        occupancy: 41,
        deviceReportedAt: '2026-10-17T11:05:00.000Z',
        receivedAt: RECEIVED_AT,
        rawPayloadHash: HASH,
      },
    ]);
    expect(result.events).toEqual([]);
  });

  it('keeps each line separate and never reports a negative occupancy', () => {
    const result = ok(map(twoLines, { lineEntryPoints: { '2': 'side-door' } }));
    expect(
      result.readings.map((r) => [
        r.sourceLine,
        r.entryPointId,
        r.countIn,
        r.countOut,
        r.occupancy,
      ]),
    ).toEqual([
      ['1', 'front-door', 30, 4, 100],
      ['2', 'side-door', 2, 9, null],
    ]);
  });

  it('gives unmapped lines a deterministic entry point of their own', () => {
    const result = ok(map(twoLines));
    expect(result.readings.map((r) => r.entryPointId)).toEqual(['front-door', 'front-door:line-2']);
  });

  it('leaves occupancy empty when the device does not send line totals', () => {
    const body = clone(periodic) as Record<string, unknown>;
    delete body.line_total_data;
    expect(ok(map(body)).readings[0]?.occupancy).toBeNull();
  });

  it('ignores unknown extra fields anywhere in the payload', () => {
    const body = clone(periodic) as Record<string, unknown> & {
      line_periodic_data: Record<string, unknown>[];
    };
    body.firmware_feature_x = { nested: [1, 2, 3] };
    body.line_periodic_data[0]!.new_counter = 5;
    expect(ok(map(body)).readings).toHaveLength(1);
  });

  it('accepts an array of reports in one request', () => {
    const later = clone(periodic);
    later.time_info.start_time = '2026-10-17T19:05:00+08:00';
    later.time_info.end_time = '2026-10-17T19:10:00+08:00';
    const result = ok(map([periodic, later]));
    expect(result.readings.map((r) => r.intervalStart)).toEqual([
      '2026-10-17T11:00:00.000Z',
      '2026-10-17T11:05:00.000Z',
    ]);
  });
});

describe('Milesight reports that are not readings', () => {
  it('does not turn trigger reports into readings, so crossings are not counted twice', () => {
    const line = ok(map(triggerLine));
    expect(line.readings).toEqual([]);
    expect(line.reportTypes).toEqual(['line_trigger']);
    expect(line.events).toEqual([{ type: 'report_ignored', detail: { type: 'line_trigger' } }]);

    const region = ok(map(triggerRegion));
    expect(region.readings).toEqual([]);
    expect(region.events).toEqual([{ type: 'report_ignored', detail: { type: 'region_trigger' } }]);
  });

  it('records an occlusion alarm as a device event with fixed vocabulary', () => {
    const result = ok(map(occlusion));
    expect(result.readings).toEqual([]);
    expect(result.events).toEqual([
      { type: 'device_alarm', detail: { alarm: 'occlusion', status: 'occluded' } },
    ]);
    const other = clone(occlusion);
    other.tof_occlusion_trigger.occlusion_status = 'something <script>';
    expect(ok(map(other)).events[0]?.detail.status).toBe('other');
  });

  it('accepts a report with device and time info but nothing we recognise', () => {
    const result = ok(map({ device_info: { device_sn: 'TEST1' }, time_info: {} }));
    expect(result.readings).toEqual([]);
    expect(result.reportTypes).toEqual(['unrecognised']);
  });
});

describe('Milesight payload validation', () => {
  const expectCode = (
    body: unknown,
    code: string,
    overrides: Partial<CounterDeviceContext> = {},
  ) => {
    const outcome = map(body, overrides);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(code);
    return outcome;
  };

  it('rejects things that are not reports', () => {
    for (const body of [null, 42, 'text', [], {}, { device_info: {} }]) {
      expectCode(body, 'invalid_payload');
    }
    expectCode(
      Array.from({ length: 101 }, () => periodic),
      'too_many_reports',
    );
  });

  it('is strict on the fields it uses', () => {
    const cases: [string, (b: typeof periodic) => void][] = [
      ['negative count', (b) => (b.line_periodic_data[0]!.in = -1)],
      ['fractional count', (b) => (b.line_periodic_data[0]!.out = 1.5)],
      ['huge count', (b) => (b.line_periodic_data[0]!.in = 1_000_001)],
      ['count as string', (b) => ((b.line_periodic_data[0] as Record<string, unknown>).in = '3')],
      ['line zero', (b) => (b.line_periodic_data[0]!.line = 0)],
      ['missing out', (b) => delete (b.line_periodic_data[0] as Partial<{ out: number }>).out],
      ['serial missing', (b) => delete (b.device_info as Partial<{ device_sn: string }>).device_sn],
      ['serial too long', (b) => (b.device_info.device_sn = 'x'.repeat(65))],
    ];
    for (const [name, mutate] of cases) {
      const body = clone(periodic);
      mutate(body);
      const outcome = map(body);
      expect(outcome.ok, name).toBe(false);
      if (!outcome.ok) expect(outcome.code, name).toBe('invalid_payload');
    }
  });

  it('reports only field paths, never values, when validation fails', () => {
    const body = clone(periodic);
    body.device_info.device_sn = '';
    (body.line_periodic_data[0] as Record<string, unknown>).in = 'SECRET-LOOKING-VALUE';
    const outcome = map(body);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.paths.join(' ')).not.toContain('SECRET');
      expect(outcome.paths).toContain('[0].line_periodic_data.0.in');
    }
  });

  it('needs the interval start and end on periodic reports', () => {
    const body = clone(periodic) as { time_info: Record<string, unknown> };
    delete body.time_info.start_time;
    expectCode(body, 'missing_interval');
  });

  it('rejects timestamps without an offset and impossible intervals', () => {
    const noOffset = clone(periodic);
    noOffset.time_info.end_time = '2026-10-17T19:05:00';
    expectCode(noOffset, 'invalid_timestamp');

    const backwards = clone(periodic);
    backwards.time_info.end_time = '2026-10-17T18:55:00+08:00';
    expectCode(backwards, 'invalid_interval');

    const zeroLength = clone(periodic);
    zeroLength.time_info.end_time = zeroLength.time_info.start_time;
    expectCode(zeroLength, 'invalid_interval');

    const tooLong = clone(periodic);
    tooLong.time_info.end_time = '2026-10-18T19:00:01+08:00';
    expectCode(tooLong, 'invalid_interval');
  });

  it('rejects the same line twice in one report', () => {
    const body = clone(twoLines);
    body.line_periodic_data[1]!.line = 1;
    expectCode(body, 'duplicate_line');
  });

  it('rejects two lines that resolve to the same entry point instead of overwriting counts', () => {
    // Review F1: line 2 mapped onto the device's own entry point (line 1's).
    expectCode(twoLines, 'duplicate_entry_point', { lineEntryPoints: { '2': 'front-door' } });
    // Two explicit mappings onto one entry point.
    expectCode(twoLines, 'duplicate_entry_point', {
      lineEntryPoints: { '1': 'side', '2': 'side' },
    });
    // An explicit mapping that collides with another line's automatic id.
    const body = clone(twoLines);
    body.line_periodic_data[1]!.line = 3;
    expectCode(body, 'duplicate_entry_point', { lineEntryPoints: { '1': 'front-door:line-3' } });
    // Distinct mappings are fine.
    expect(map(twoLines, { lineEntryPoints: { '2': 'side' } }).ok).toBe(true);
  });
});

describe('counter registry and helpers', () => {
  it('finds the Milesight adapter by provider key only', () => {
    expect(getCounterAdapter('milesight')?.provider).toBe('milesight');
    expect(getCounterAdapter('Milesight')).toBeUndefined();
    expect(getCounterAdapter('__proto__')).toBeUndefined();
  });

  it('hashes the exact body bytes', () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    expect(hashPayload(bytes)).toBe(
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
    expect(hashPayload(new TextEncoder().encode('{"a": 1}'))).not.toBe(hashPayload(bytes));
  });

  it('resolves entry points with explicit mappings first', () => {
    const ctx = { ...device, lineEntryPoints: { '1': 'main', '3': '' } };
    expect(resolveEntryPointId(ctx, '1')).toBe('main');
    expect(resolveEntryPointId(ctx, '3')).toBe('front-door:line-3');
    expect(resolveEntryPointId(device, '1')).toBe('front-door');
  });
});
