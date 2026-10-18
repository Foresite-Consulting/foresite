import { beforeEach, describe, expect, it } from 'vitest';
import type {
  DeviceRecord,
  IngestBatch,
  IngestEventToStore,
  IngestRepository,
  ReadingToStore,
} from './repository';

/**
 * Behaviour every IngestRepository must have. Run against the in-memory
 * adapter and against PostgreSQL (PGlite) so the two cannot drift apart.
 */

export interface ContractHarness {
  repository: IngestRepository;
  seed(device: DeviceRecord): Promise<void>;
}

export const CONTRACT_DEVICE: DeviceRecord = {
  provider: 'milesight',
  deviceId: 'contract-dev',
  venueId: 'venue-contract',
  entryPointId: 'front',
  lineEntryPoints: { '2': 'side' },
  vendorSerial: 'TEST0000000009',
  active: true,
  secretHashes: [
    'scrypt$v=1$n=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ],
};

const BASE = Date.parse('2026-10-17T11:00:00.000Z');
const MIN = 60_000;

export function reading(
  slot: number,
  counts: { in: number; out: number; occupancy?: number | null },
  options: { hash?: string; reportedOffsetMs?: number; receivedAt?: string; entry?: string } = {},
): ReadingToStore {
  const start = BASE + slot * 5 * MIN;
  const end = start + 5 * MIN;
  return {
    provider: 'milesight',
    deviceId: CONTRACT_DEVICE.deviceId,
    venueId: CONTRACT_DEVICE.venueId,
    entryPointId: options.entry ?? 'front',
    sourceLine: '1',
    intervalStart: new Date(start).toISOString(),
    intervalEnd: new Date(end).toISOString(),
    countIn: counts.in,
    countOut: counts.out,
    occupancy: counts.occupancy ?? null,
    deviceReportedAt: new Date(end + (options.reportedOffsetMs ?? 0)).toISOString(),
    receivedAt: options.receivedAt ?? new Date(end + 2_000).toISOString(),
    rawPayloadHash: options.hash ?? 'a'.repeat(64),
    flag: null,
  };
}

export function batch(
  hash: string,
  readings: ReadingToStore[],
  events: IngestEventToStore[] = [],
): IngestBatch {
  return {
    raw: {
      venueId: CONTRACT_DEVICE.venueId,
      deviceId: CONTRACT_DEVICE.deviceId,
      provider: 'milesight',
      payloadHash: hash,
      payload: { synthetic: true, hash },
      receivedAt: readings[0]?.receivedAt ?? new Date(BASE).toISOString(),
      parseStatus: 'mapped',
      errorCode: null,
      strippedKeys: [],
    },
    readings: readings.map((r) => ({ ...r, rawPayloadHash: hash })),
    events,
    summary: (result) => ({
      venueId: CONTRACT_DEVICE.venueId,
      deviceId: CONTRACT_DEVICE.deviceId,
      type: 'request',
      occurredAt: readings[0]?.receivedAt ?? new Date(BASE).toISOString(),
      detail: {
        accepted: result.outcomes.filter((o) => o.kind === 'accepted').length,
        raw_duplicate: !result.rawStored,
      },
    }),
  };
}

const h = (n: number) => n.toString(16).padStart(64, '0');

export function describeRepositoryContract(
  name: string,
  makeHarness: () => Promise<ContractHarness>,
) {
  describe(`${name}: IngestRepository contract`, () => {
    let harness: ContractHarness;
    let repo: IngestRepository;

    beforeEach(async () => {
      harness = await makeHarness();
      repo = harness.repository;
      await harness.seed(CONTRACT_DEVICE);
    });

    it('finds a device by provider and id, with its secrets and line mapping', async () => {
      const found = await repo.findDevice('milesight', 'contract-dev');
      expect(found).toEqual(CONTRACT_DEVICE);
      expect(await repo.findDevice('othervendor', 'contract-dev')).toBeNull();
      expect(await repo.findDevice('milesight', 'nobody')).toBeNull();
    });

    it('accepts new readings and reports exact re-sends as duplicates', async () => {
      const first = await repo.ingest(batch(h(1), [reading(0, { in: 5, out: 1, occupancy: 4 })]));
      expect(first).toEqual({ rawStored: true, outcomes: [{ kind: 'accepted' }] });
      const again = await repo.ingest(batch(h(1), [reading(0, { in: 5, out: 1, occupancy: 4 })]));
      expect(again).toEqual({ rawStored: false, outcomes: [{ kind: 'duplicate' }] });
      const readings = await repo.listReadings('contract-dev');
      expect(readings).toHaveLength(1);
      expect(readings[0]).toMatchObject({ countIn: 5, countOut: 1, occupancy: 4, revision: 1 });
    });

    it('treats a different body with the same counts as a duplicate, not a conflict', async () => {
      await repo.ingest(batch(h(1), [reading(0, { in: 5, out: 1 })]));
      const other = await repo.ingest(batch(h(2), [reading(0, { in: 5, out: 1 })]));
      expect(other).toEqual({ rawStored: true, outcomes: [{ kind: 'duplicate' }] });
      expect((await repo.listReadings('contract-dev'))[0]?.rawPayloadHash).toBe(h(1));
    });

    it('lets the later device timestamp win a conflict and records both versions', async () => {
      await repo.ingest(batch(h(1), [reading(0, { in: 5, out: 1 })]));
      const newer = await repo.ingest(
        batch(h(2), [reading(0, { in: 7, out: 2 }, { reportedOffsetMs: 1_000 })]),
      );
      expect(newer.outcomes).toEqual([{ kind: 'conflict', resolution: 'replaced' }]);
      const [stored] = await repo.listReadings('contract-dev');
      expect(stored).toMatchObject({ countIn: 7, countOut: 2, revision: 2, rawPayloadHash: h(2) });

      const older = await repo.ingest(
        batch(h(3), [reading(0, { in: 9, out: 9 }, { reportedOffsetMs: -1_000 })]),
      );
      expect(older.outcomes).toEqual([{ kind: 'conflict', resolution: 'kept_existing' }]);
      expect((await repo.listReadings('contract-dev'))[0]).toMatchObject({
        countIn: 7,
        revision: 2,
      });

      const conflicts = (await repo.listEvents('contract-dev')).filter(
        (e) => e.type === 'reading_conflict',
      );
      expect(conflicts.map((e) => e.detail.resolution)).toEqual(['replaced', 'kept_existing']);
      expect(conflicts[0]?.detail).toMatchObject({
        existing_count_in: 5,
        incoming_count_in: 7,
        existing_raw_payload_hash: h(1),
        incoming_raw_payload_hash: h(2),
      });
    });

    it('lets the later arrival win when device timestamps tie', async () => {
      await repo.ingest(batch(h(1), [reading(0, { in: 5, out: 1 })]));
      const tie = await repo.ingest(batch(h(2), [reading(0, { in: 6, out: 1 })]));
      expect(tie.outcomes).toEqual([{ kind: 'conflict', resolution: 'replaced' }]);
    });

    it('counts a change in occupancy alone as a conflict', async () => {
      await repo.ingest(batch(h(1), [reading(0, { in: 5, out: 1, occupancy: 10 })]));
      const result = await repo.ingest(
        batch(h(2), [reading(0, { in: 5, out: 1, occupancy: null })]),
      );
      expect(result.outcomes).toEqual([{ kind: 'conflict', resolution: 'replaced' }]);
    });

    it('keeps entry points and intervals apart', async () => {
      const result = await repo.ingest(
        batch(h(1), [
          reading(0, { in: 1, out: 0 }),
          reading(0, { in: 2, out: 0 }, { entry: 'side' }),
          reading(1, { in: 3, out: 0 }),
        ]),
      );
      expect(result.outcomes.map((o) => o.kind)).toEqual(['accepted', 'accepted', 'accepted']);
      expect(
        (await repo.listReadings('contract-dev')).map((r) => [r.entryPointId, r.countIn]),
      ).toEqual([
        ['front', 1],
        ['side', 2],
        ['front', 3],
      ]);
    });

    it('never double counts a replay of buffered data after an outage', async () => {
      // Three intervals arrive live.
      for (const slot of [0, 1, 2]) {
        await repo.ingest(batch(h(10 + slot), [reading(slot, { in: 10 + slot, out: slot })]));
      }
      // The device reconnects and re-sends the same three packets...
      for (const slot of [0, 1, 2]) {
        const again = await repo.ingest(
          batch(h(10 + slot), [reading(slot, { in: 10 + slot, out: slot })]),
        );
        expect(again.outcomes).toEqual([{ kind: 'duplicate' }]);
      }
      // ...then a backfill that overlaps them and adds the outage intervals 3 and 4.
      const backfill = await repo.ingest(
        batch(
          h(99),
          [1, 2, 3, 4].map((slot) => reading(slot, { in: 10 + slot, out: slot })),
        ),
      );
      expect(backfill.outcomes.map((o) => o.kind)).toEqual([
        'duplicate',
        'duplicate',
        'accepted',
        'accepted',
      ]);

      const stored = await repo.listReadings('contract-dev');
      expect(stored).toHaveLength(5);
      expect(stored.reduce((sum, r) => sum + r.countIn, 0)).toBe(10 + 11 + 12 + 13 + 14);
      expect(stored.reduce((sum, r) => sum + r.countOut, 0)).toBe(0 + 1 + 2 + 3 + 4);
      expect(stored.every((r) => r.revision === 1)).toBe(true);
    });

    it('serialises concurrent re-sends of one interval so only one insert wins', async () => {
      const results = await Promise.all([
        repo.ingest(batch(h(1), [reading(0, { in: 5, out: 1 })])),
        repo.ingest(batch(h(2), [reading(0, { in: 5, out: 1 })])),
        repo.ingest(batch(h(3), [reading(0, { in: 6, out: 1 })])),
      ]);
      const kinds = results.flatMap((r) => r.outcomes.map((o) => o.kind));
      expect(kinds.filter((k) => k === 'accepted')).toHaveLength(1);
      expect(await repo.listReadings('contract-dev')).toHaveLength(1);
    });

    it('stores rejected payloads and audit events', async () => {
      const raw = batch(h(5), []).raw;
      await repo.rejectPayload(
        { ...raw, parseStatus: 'rejected', errorCode: 'invalid_payload' },
        {
          venueId: CONTRACT_DEVICE.venueId,
          deviceId: CONTRACT_DEVICE.deviceId,
          type: 'payload_rejected',
          occurredAt: '2026-10-17T11:00:00.000Z',
          detail: { error_code: 'invalid_payload' },
        },
      );
      await repo.recordEvent({
        venueId: CONTRACT_DEVICE.venueId,
        deviceId: CONTRACT_DEVICE.deviceId,
        type: 'device_alarm',
        occurredAt: '2026-10-17T11:01:00.000Z',
        detail: { alarm: 'occlusion', status: 'occluded' },
      });
      const events = await repo.listEvents('contract-dev');
      expect(events.map((e) => e.type)).toEqual(['payload_rejected', 'device_alarm']);
      expect(events[1]?.occurredAt).toBe('2026-10-17T11:01:00.000Z');
      // The same body stored again later is not a second raw row.
      const later = await repo.ingest(batch(h(5), [reading(0, { in: 1, out: 1 })]));
      expect(later.rawStored).toBe(false);
    });

    it('keeps the payload and the names of stripped keys with the raw row', async () => {
      const b = batch(h(7), []);
      await repo.ingest({ ...b, raw: { ...b.raw, strippedKeys: ['device_mac', 'network_info'] } });
      await repo.ingest(batch(h(8), []));
      const raws = await repo.listRawPayloads('contract-dev');
      expect(raws).toEqual([
        {
          payloadHash: h(7),
          payload: { synthetic: true, hash: h(7) },
          parseStatus: 'mapped',
          errorCode: null,
          strippedKeys: ['device_mac', 'network_info'],
        },
        expect.objectContaining({ payloadHash: h(8), strippedKeys: [] }),
      ]);
    });

    it('stores overlapping intervals as distinct rows and flags the overlap (review F5)', async () => {
      // Three 5-minute readings, then one 15-minute reading over the last two
      // (a reporting period changed on the device), plus an adjacent one.
      await repo.ingest(
        batch(h(1), [
          reading(0, { in: 1, out: 0 }),
          reading(1, { in: 2, out: 0 }),
          reading(2, { in: 3, out: 0 }),
        ]),
      );
      const long: ReadingToStore = {
        ...reading(1, { in: 9, out: 0 }, { hash: h(2) }),
        intervalEnd: reading(3, { in: 0, out: 0 }).intervalStart,
      };
      const adjacent = reading(3, { in: 4, out: 0 }, { hash: h(2) });
      const other = reading(1, { in: 5, out: 0 }, { hash: h(2), entry: 'side' });
      const result = await repo.ingest(batch(h(2), [long, adjacent, other]));
      expect(result.outcomes.map((o) => o.kind)).toEqual(['accepted', 'accepted', 'accepted']);
      expect(await repo.listReadings('contract-dev')).toHaveLength(6);
      const overlaps = (await repo.listEvents('contract-dev')).filter(
        (e) => e.type === 'overlap_detected',
      );
      expect(overlaps).toEqual([
        {
          venueId: CONTRACT_DEVICE.venueId,
          deviceId: CONTRACT_DEVICE.deviceId,
          type: 'overlap_detected',
          occurredAt: long.receivedAt,
          detail: {
            entry_point_id: 'front',
            interval_start: long.intervalStart,
            interval_end: long.intervalEnd,
            overlapping_readings: 2,
          },
        },
      ]);
      // A re-send of the long reading is a duplicate and is not flagged again.
      await repo.ingest(batch(h(3), [long]));
      expect(
        (await repo.listEvents('contract-dev')).filter((e) => e.type === 'overlap_detected'),
      ).toHaveLength(1);
    });

    it('writes the request summary in the same batch', async () => {
      await repo.ingest(batch(h(1), [reading(0, { in: 5, out: 1 })]));
      const summary = (await repo.listEvents('contract-dev')).find((e) => e.type === 'request');
      expect(summary?.detail).toEqual({ accepted: 1, raw_duplicate: false });
    });
  });
}
