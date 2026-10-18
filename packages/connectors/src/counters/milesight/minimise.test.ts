import { describe, expect, it } from 'vitest';
import type { CounterDeviceContext } from '../types';
import periodic from './fixtures/periodic-line.json';
import { mapMilesightPayload } from './map';
import { isStrippedKey, minimiseMilesightPayload } from './minimise';

const device: CounterDeviceContext = {
  provider: 'milesight',
  deviceId: 'fs-test-door-01',
  venueId: 'venue-test',
  entryPointId: 'front-door',
  lineEntryPoints: {},
  vendorSerial: 'TEST0000000001',
};

describe('Milesight data minimisation', () => {
  it('removes network and SIM identifiers from the documented payload, listing key names only', () => {
    const { payload, strippedKeys } = minimiseMilesightPayload(periodic);
    expect(strippedKeys).toEqual(['device_mac', 'ip_address', 'network_info']);
    const text = JSON.stringify(payload);
    for (const value of ['TEST-ICCID', 'TEST-IMEI', '00:00:5E:00:53:01', '192.0.2.10']) {
      expect(text).not.toContain(value);
    }
    expect(JSON.stringify(strippedKeys)).not.toContain('TEST-');
    // What counting needs is untouched.
    const kept = payload as typeof periodic;
    expect(kept.device_info.device_sn).toBe('TEST0000000001');
    expect(kept.line_periodic_data).toEqual(periodic.line_periodic_data);
    expect(kept.time_info).toEqual(periodic.time_info);
    // The input is not modified.
    expect(periodic.network_info.imei).toBe('TEST-IMEI');
  });

  it('maps the minimised payload to the same readings as the original', () => {
    const input = {
      device,
      receivedAt: '2026-10-17T11:05:03.000Z',
      rawPayloadHash: 'a'.repeat(64),
    };
    const before = mapMilesightPayload({ ...input, body: periodic });
    const after = mapMilesightPayload({
      ...input,
      body: minimiseMilesightPayload(periodic).payload,
    });
    expect(after).toEqual(before);
  });

  it('finds identifiers anywhere, in any case or spelling, including in arrays of reports', () => {
    const body = [
      {
        device_info: { device_sn: 'TEST1', MAC: 'x' },
        nodeDeviceInfo: [{ device_sn: 'TEST-NODE', device_mac: 'y' }],
        extra: { deep: { cellId: '1', LAC: '2', IMSI: '3', msisdn: '4', ICCID: '5' } },
      },
      { device_info: { device_sn: 'TEST2' }, line_trigger_data: [{ ip_address: '192.0.2.1' }] },
    ];
    const { payload, strippedKeys } = minimiseMilesightPayload(body);
    expect(strippedKeys).toEqual([
      'ICCID',
      'IMSI',
      'LAC',
      'MAC',
      'cellId',
      'ip_address',
      'msisdn',
      'nodeDeviceInfo',
    ]);
    expect(payload).toEqual([
      { device_info: { device_sn: 'TEST1' }, extra: { deep: {} } },
      { device_info: { device_sn: 'TEST2' }, line_trigger_data: [{}] },
    ]);
  });

  it('leaves look-alike keys alone and keeps __proto__ an ordinary key', () => {
    expect(['machine', 'lack', 'line', 'image', 'ip', 'device_sn'].some(isStrippedKey)).toBe(false);
    const body = JSON.parse('{"__proto__":{"mac":"x","a":1},"b":2}') as unknown;
    const { payload, strippedKeys } = minimiseMilesightPayload(body);
    expect(strippedKeys).toEqual(['mac']);
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(JSON.stringify(payload)).toBe('{"__proto__":{"a":1},"b":2}');
  });

  it('passes scalars and an empty body through', () => {
    expect(minimiseMilesightPayload(null)).toEqual({ payload: null, strippedKeys: [] });
    expect(minimiseMilesightPayload('x')).toEqual({ payload: 'x', strippedKeys: [] });
  });
});
