import { beforeAll, describe, expect, it, vi } from 'vitest';
import { basicAuth } from '../../test/ingest-helpers';
import { authenticateDevice, parseBasicAuth } from './auth';
import { MemoryIngestRepository } from './memory-repository';
import type { DeviceRecord } from './repository';
import { generateDeviceSecret, hashDeviceSecret, verifyDeviceSecret } from './secrets';

const oldSecret = generateDeviceSecret();
const newSecret = generateDeviceSecret();
let repo: MemoryIngestRepository;

function device(overrides: Partial<DeviceRecord>): DeviceRecord {
  return {
    provider: 'milesight',
    deviceId: 'dev-one',
    venueId: 'venue-a',
    entryPointId: 'front',
    lineEntryPoints: {},
    vendorSerial: null,
    active: true,
    secretHashes: [],
    ...overrides,
  };
}

beforeAll(async () => {
  const oldHash = await hashDeviceSecret(oldSecret);
  const newHash = await hashDeviceSecret(newSecret);
  repo = new MemoryIngestRepository([
    device({ deviceId: 'dev-one', secretHashes: [oldHash] }),
    device({ deviceId: 'dev-rotating', secretHashes: [oldHash, newHash] }),
    device({ deviceId: 'dev-off', secretHashes: [oldHash], active: false }),
    device({ deviceId: 'dev-other-vendor', provider: 'othervendor', secretHashes: [oldHash] }),
  ]);
});

describe('parseBasicAuth', () => {
  it('reads device id and secret', () => {
    expect(parseBasicAuth(basicAuth('dev-one', 'abc:def'))).toEqual({
      deviceId: 'dev-one',
      secret: 'abc:def',
    });
    expect(parseBasicAuth(`basic ${Buffer.from('dev-one:s').toString('base64')}`)).not.toBeNull();
  });

  it('rejects anything malformed', () => {
    for (const header of [
      null,
      '',
      'Bearer abc',
      'Basic',
      'Basic !!!',
      basicAuth('dev-one', ''),
      basicAuth('', 'secret'),
      basicAuth('a', 'secret'),
      basicAuth('dev one', 'secret'),
      basicAuth('../etc/passwd', 'secret'),
      basicAuth('x'.repeat(65), 'secret'),
      basicAuth('dev-one', 'x'.repeat(257)),
      `Basic ${Buffer.from('no-colon').toString('base64')}`,
      `Basic ${'A'.repeat(2000)}`,
    ]) {
      expect(parseBasicAuth(header), String(header).slice(0, 40)).toBeNull();
    }
  });
});

describe('authenticateDevice', () => {
  it('accepts the device secret and says which slot matched', async () => {
    const result = await authenticateDevice(repo, 'milesight', basicAuth('dev-one', oldSecret));
    expect(result).toMatchObject({ ok: true, slot: 1, device: { deviceId: 'dev-one' } });
  });

  it('accepts either secret while a rotation is in progress', async () => {
    expect(
      await authenticateDevice(repo, 'milesight', basicAuth('dev-rotating', oldSecret)),
    ).toMatchObject({ ok: true, slot: 1 });
    expect(
      await authenticateDevice(repo, 'milesight', basicAuth('dev-rotating', newSecret)),
    ).toMatchObject({ ok: true, slot: 2 });
  });

  it('rejects wrong secrets, unknown devices, inactive devices and other providers', async () => {
    expect(await authenticateDevice(repo, 'milesight', basicAuth('dev-one', newSecret))).toEqual({
      ok: false,
      reason: 'bad_secret',
    });
    expect(await authenticateDevice(repo, 'milesight', basicAuth('dev-nope', oldSecret))).toEqual({
      ok: false,
      reason: 'unknown_device',
    });
    expect(await authenticateDevice(repo, 'milesight', basicAuth('dev-off', oldSecret))).toEqual({
      ok: false,
      reason: 'inactive',
    });
    expect(
      await authenticateDevice(repo, 'milesight', basicAuth('dev-other-vendor', oldSecret)),
    ).toEqual({ ok: false, reason: 'unknown_device' });
    expect(await authenticateDevice(repo, 'milesight', null)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('does the same scrypt work on every path, so timing does not reveal which devices exist', async () => {
    const cases: [string | null, string][] = [
      [null, 'malformed'],
      [basicAuth('dev-nope', oldSecret), 'unknown'],
      [basicAuth('dev-one', newSecret), 'bad secret, one slot'],
      [basicAuth('dev-one', oldSecret), 'good, one slot'],
      [basicAuth('dev-rotating', newSecret), 'good, two slots'],
      [basicAuth('dev-off', oldSecret), 'inactive'],
    ];
    for (const [header, name] of cases) {
      const verify = vi.fn(verifyDeviceSecret);
      await authenticateDevice(repo, 'milesight', header, verify);
      expect(verify, name).toHaveBeenCalledTimes(2);
    }
  });
});
