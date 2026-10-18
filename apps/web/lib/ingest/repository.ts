import type { CounterDeviceContext, CounterReading } from '@foresite/connectors/counters';

/**
 * Storage for counter ingest. Two adapters implement it with the same rules:
 * `memory-repository.ts` (tests, local runs) and `postgres-repository.ts`
 * (production, SQL in `db/migrations/0001_counter_ingest.sql`). The shared
 * contract tests in `repository.contract.ts` run against both.
 */

export interface DeviceRecord extends CounterDeviceContext {
  active: boolean;
  /** One encoded scrypt hash, or two while a secret is being rotated. */
  secretHashes: string[];
}

/** Clock flag on a stored reading. `late` = buffered data that arrived well after its interval. */
export type ReadingFlag = 'late' | null;

export interface ReadingToStore extends CounterReading {
  flag: ReadingFlag;
}

export type RawParseStatus = 'mapped' | 'rejected';

export interface RawPayloadToStore {
  venueId: string;
  deviceId: string;
  provider: string;
  payloadHash: string;
  /**
   * The parsed JSON body after data minimisation (the adapter's `minimise`
   * removes device and SIM identifiers). Stored as jsonb so a mapping bug can
   * be replayed.
   */
  payload: unknown;
  /** Names of the keys minimisation removed (stored in the row's metadata). Never values. */
  strippedKeys: string[];
  receivedAt: string;
  parseStatus: RawParseStatus;
  /** Safe error code when `parseStatus` is `rejected`. */
  errorCode: string | null;
}

export const INGEST_EVENT_TYPES = [
  'request',
  'reading_conflict',
  'reading_rejected_clock',
  'device_alarm',
  'payload_rejected',
  'device_mismatch',
  'overlap_detected',
] as const;
export type IngestEventType = (typeof INGEST_EVENT_TYPES)[number];

export interface IngestEventToStore {
  venueId: string;
  deviceId: string;
  type: IngestEventType;
  occurredAt: string;
  /** Fixed vocabulary, ids, timestamps and counts only. Never payload text. */
  detail: Record<string, string | number | boolean | null>;
}

export type ReadingOutcome =
  | { kind: 'accepted' }
  | { kind: 'duplicate' }
  | { kind: 'conflict'; resolution: 'replaced' | 'kept_existing' };

export interface IngestBatch {
  raw: RawPayloadToStore;
  readings: ReadingToStore[];
  /** Events recorded alongside the readings (alarms, clock rejections). */
  events: IngestEventToStore[];
  /** Builds the request summary event from the outcome, written in the same transaction. */
  summary?: (result: IngestBatchResult) => IngestEventToStore;
}

export interface IngestBatchResult {
  /** False when the exact same body had already been stored for this device. */
  rawStored: boolean;
  outcomes: ReadingOutcome[];
}

/** A stored raw payload, as read back for tests and operators. */
export interface StoredRawPayload {
  payloadHash: string;
  payload: unknown;
  parseStatus: RawParseStatus;
  errorCode: string | null;
  strippedKeys: string[];
}

/** A stored reading, as read back for tests and the dedupe rule. */
export interface StoredReading {
  deviceId: string;
  entryPointId: string;
  intervalStart: string;
  intervalEnd: string;
  countIn: number;
  countOut: number;
  occupancy: number | null;
  deviceReportedAt: string;
  receivedAt: string;
  rawPayloadHash: string;
  flag: ReadingFlag;
  revision: number;
}

export interface IngestRepository {
  findDevice(provider: string, deviceId: string): Promise<DeviceRecord | null>;
  /**
   * Store the raw payload, upsert the readings by their natural key and record
   * conflict events, all in one transaction. Applies `decideReading` per reading.
   */
  ingest(batch: IngestBatch): Promise<IngestBatchResult>;
  /** Store a raw payload that failed validation, plus an event. */
  rejectPayload(raw: RawPayloadToStore, event: IngestEventToStore): Promise<void>;
  /** Record an audit event on its own (request summaries, mismatches). */
  recordEvent(event: IngestEventToStore): Promise<void>;
  /** Read back, ordered by interval start then entry point. For tests and operators. */
  listReadings(deviceId: string): Promise<StoredReading[]>;
  /** Read back, oldest first. For tests and operators. */
  listEvents(deviceId: string): Promise<IngestEventToStore[]>;
  /** Read back, oldest first. For tests and operators. */
  listRawPayloads(deviceId: string): Promise<StoredRawPayload[]>;
}

/** The natural key a reading is deduplicated on. */
export function readingKey(r: {
  deviceId: string;
  entryPointId: string;
  intervalStart: string;
  intervalEnd: string;
}): string {
  return JSON.stringify([r.deviceId, r.entryPointId, r.intervalStart, r.intervalEnd]);
}

export type ReadingDecision = 'duplicate' | 'replace' | 'keep_existing';

/**
 * The dedupe rule, shared by both adapters.
 *
 * - Same key, same counts (in, out, occupancy): a duplicate, e.g. the device
 *   re-sending buffered data after an outage. Nothing changes.
 * - Same key, different counts: a conflict. The reading with the later
 *   device timestamp (`deviceReportedAt`) wins; on a tie the one received
 *   later wins (the incoming one, because it is being received now). The
 *   loser is kept in the conflict event's detail, so nothing is lost.
 */
export function decideReading(
  existing: Pick<StoredReading, 'countIn' | 'countOut' | 'occupancy' | 'deviceReportedAt'>,
  incoming: Pick<ReadingToStore, 'countIn' | 'countOut' | 'occupancy' | 'deviceReportedAt'>,
): ReadingDecision {
  if (
    existing.countIn === incoming.countIn &&
    existing.countOut === incoming.countOut &&
    existing.occupancy === incoming.occupancy
  ) {
    return 'duplicate';
  }
  const existingAt = Date.parse(existing.deviceReportedAt);
  const incomingAt = Date.parse(incoming.deviceReportedAt);
  return incomingAt >= existingAt ? 'replace' : 'keep_existing';
}

/**
 * Longest reading interval storage accepts (also a check constraint). Bounds
 * the overlap lookup to a range scan of the natural-key index.
 */
export const MAX_READING_INTERVAL_HOURS = 24;

/** Whether two half-open intervals [start, end) overlap. ISO 8601 UTC strings. */
export function intervalsOverlap(
  a: { intervalStart: string; intervalEnd: string },
  b: { intervalStart: string; intervalEnd: string },
): boolean {
  return (
    Date.parse(a.intervalStart) < Date.parse(b.intervalEnd) &&
    Date.parse(b.intervalStart) < Date.parse(a.intervalEnd)
  );
}

/**
 * A newly stored reading overlaps readings already stored for the same
 * device and entry point with a different interval (review F5), e.g. a device
 * whose reporting period was changed from 5 to 60 minutes and back. Both are
 * kept; this event flags the overlap so the trading-day join (and an
 * operator) can tell. Not a rejection.
 */
export function overlapEvent(reading: ReadingToStore, overlapping: number): IngestEventToStore {
  return {
    venueId: reading.venueId,
    deviceId: reading.deviceId,
    type: 'overlap_detected',
    occurredAt: reading.receivedAt,
    detail: {
      entry_point_id: reading.entryPointId,
      interval_start: reading.intervalStart,
      interval_end: reading.intervalEnd,
      overlapping_readings: overlapping,
    },
  };
}

export function conflictEvent(
  existing: StoredReading,
  incoming: ReadingToStore,
  decision: Exclude<ReadingDecision, 'duplicate'>,
): IngestEventToStore {
  return {
    venueId: incoming.venueId,
    deviceId: incoming.deviceId,
    type: 'reading_conflict',
    occurredAt: incoming.receivedAt,
    detail: {
      entry_point_id: incoming.entryPointId,
      interval_start: incoming.intervalStart,
      interval_end: incoming.intervalEnd,
      resolution: decision === 'replace' ? 'replaced' : 'kept_existing',
      existing_count_in: existing.countIn,
      existing_count_out: existing.countOut,
      existing_occupancy: existing.occupancy,
      existing_device_reported_at: existing.deviceReportedAt,
      existing_raw_payload_hash: existing.rawPayloadHash,
      incoming_count_in: incoming.countIn,
      incoming_count_out: incoming.countOut,
      incoming_occupancy: incoming.occupancy,
      incoming_device_reported_at: incoming.deviceReportedAt,
      incoming_raw_payload_hash: incoming.rawPayloadHash,
    },
  };
}
