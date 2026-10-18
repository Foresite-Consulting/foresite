import {
  conflictEvent,
  decideReading,
  readingKey,
  type DeviceRecord,
  type IngestBatch,
  type IngestBatchResult,
  type IngestEventToStore,
  type IngestRepository,
  type RawPayloadToStore,
  type ReadingOutcome,
  type StoredRawPayload,
  type StoredReading,
} from './repository';

/**
 * In-memory repository with the same rules as the PostgreSQL adapter. For
 * unit tests, route tests, local runs and the Playwright server. State lives
 * in one process and is lost on restart: never use it in production.
 */
export class MemoryIngestRepository implements IngestRepository {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly raw = new Map<string, RawPayloadToStore>();
  private readonly readings = new Map<string, StoredReading>();
  private readonly events: IngestEventToStore[] = [];
  /** Serialises writes the way a database transaction would. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(devices: DeviceRecord[] = []) {
    for (const device of devices) this.addDevice(device);
  }

  addDevice(device: DeviceRecord): void {
    this.devices.set(JSON.stringify([device.provider, device.deviceId]), structuredClone(device));
  }

  findDevice(provider: string, deviceId: string): Promise<DeviceRecord | null> {
    const device = this.devices.get(JSON.stringify([provider, deviceId]));
    return Promise.resolve(device ? structuredClone(device) : null);
  }

  private exclusive<T>(work: () => T): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private storeRaw(raw: RawPayloadToStore): boolean {
    const key = JSON.stringify([raw.deviceId, raw.payloadHash]);
    if (this.raw.has(key)) return false;
    this.raw.set(key, structuredClone(raw));
    return true;
  }

  ingest(batch: IngestBatch): Promise<IngestBatchResult> {
    return this.exclusive(() => {
      const rawStored = this.storeRaw(batch.raw);
      const outcomes: ReadingOutcome[] = [];
      const newEvents: IngestEventToStore[] = [...batch.events];

      for (const incoming of batch.readings) {
        const key = readingKey(incoming);
        const existing = this.readings.get(key);
        const stored: StoredReading = {
          deviceId: incoming.deviceId,
          entryPointId: incoming.entryPointId,
          intervalStart: incoming.intervalStart,
          intervalEnd: incoming.intervalEnd,
          countIn: incoming.countIn,
          countOut: incoming.countOut,
          occupancy: incoming.occupancy,
          deviceReportedAt: incoming.deviceReportedAt,
          receivedAt: incoming.receivedAt,
          rawPayloadHash: incoming.rawPayloadHash,
          flag: incoming.flag,
          revision: 1,
        };
        if (existing === undefined) {
          this.readings.set(key, stored);
          outcomes.push({ kind: 'accepted' });
          continue;
        }
        const decision = decideReading(existing, incoming);
        if (decision === 'duplicate') {
          outcomes.push({ kind: 'duplicate' });
          continue;
        }
        newEvents.push(conflictEvent(existing, incoming, decision));
        if (decision === 'replace') {
          this.readings.set(key, { ...stored, revision: existing.revision + 1 });
          outcomes.push({ kind: 'conflict', resolution: 'replaced' });
        } else {
          outcomes.push({ kind: 'conflict', resolution: 'kept_existing' });
        }
      }
      const result = { rawStored, outcomes };
      if (batch.summary) newEvents.push(batch.summary(result));
      this.events.push(...newEvents.map((event) => structuredClone(event)));
      return result;
    });
  }

  rejectPayload(raw: RawPayloadToStore, event: IngestEventToStore): Promise<void> {
    return this.exclusive(() => {
      this.storeRaw(raw);
      this.events.push(structuredClone(event));
    });
  }

  recordEvent(event: IngestEventToStore): Promise<void> {
    return this.exclusive(() => {
      this.events.push(structuredClone(event));
    });
  }

  listReadings(deviceId: string): Promise<StoredReading[]> {
    return Promise.resolve(
      [...this.readings.values()]
        .filter((r) => r.deviceId === deviceId)
        .sort(
          (a, b) =>
            a.intervalStart.localeCompare(b.intervalStart) ||
            a.entryPointId.localeCompare(b.entryPointId),
        )
        .map((r) => structuredClone(r)),
    );
  }

  listEvents(deviceId: string): Promise<IngestEventToStore[]> {
    return Promise.resolve(
      this.events.filter((e) => e.deviceId === deviceId).map((e) => structuredClone(e)),
    );
  }

  listRawPayloads(deviceId: string): Promise<StoredRawPayload[]> {
    return Promise.resolve(
      [...this.raw.values()]
        .filter((r) => r.deviceId === deviceId)
        .map((r) => ({
          payloadHash: r.payloadHash,
          payload: structuredClone(r.payload),
          parseStatus: r.parseStatus,
          errorCode: r.errorCode,
          strippedKeys: [...r.strippedKeys],
        })),
    );
  }

  /** Number of distinct raw payloads stored. For tests. */
  rawCount(): number {
    return this.raw.size;
  }
}
