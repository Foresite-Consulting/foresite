import {
  conflictEvent,
  decideReading,
  type DeviceRecord,
  type IngestBatch,
  type IngestBatchResult,
  type IngestEventToStore,
  type IngestRepository,
  type RawPayloadToStore,
  type ReadingFlag,
  type ReadingOutcome,
  type StoredRawPayload,
  type StoredReading,
} from './repository';

/**
 * PostgreSQL adapter for the schema in `db/migrations/0001_counter_ingest.sql`.
 *
 * Driver-agnostic: it needs only `query(text, params)` and `transaction(fn)`.
 * `fromPostgresJs` wraps the `postgres` driver used in production;
 * the tests wrap PGlite (in-process PostgreSQL). Every statement is
 * parameterised; no value is ever interpolated into SQL text. JSON goes in as
 * `$n::text::jsonb` so every driver sends the string unchanged (postgres.js
 * would otherwise JSON-encode a string bound straight to a jsonb parameter).
 *
 * Concurrency: each reading is `insert … on conflict do nothing`; if the key
 * already exists the row is locked with `select … for update` before the
 * dedupe rule runs, so two concurrent re-sends of the same interval cannot
 * both win. Runs at the default READ COMMITTED isolation.
 */

export interface SqlExecutor {
  query<T extends object>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface SqlClient extends SqlExecutor {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Normalise a driver's timestamptz value (Date or string) to ISO 8601 UTC. */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  throw new TypeError('expected a timestamp');
}

interface DeviceRow {
  device_id: string;
  provider: string;
  venue_id: string;
  entry_point_id: string;
  line_entry_points: string;
  vendor_serial: string | null;
  active: boolean;
  secret_hashes: string;
}

interface ReadingRow {
  device_id: string;
  entry_point_id: string;
  interval_start: unknown;
  interval_end: unknown;
  // int4 arrives as a number from both drivers; typed loosely and converted.
  count_in: number | string;
  count_out: number | string;
  occupancy: number | string | null;
  device_reported_at: unknown;
  received_at: unknown;
  raw_payload_hash: string;
  clock_flag: ReadingFlag;
  revision: number | string;
}

interface EventRow {
  venue_id: string;
  device_id: string;
  event_type: IngestEventToStore['type'];
  occurred_at: unknown;
  detail: string;
}

const READING_COLUMNS = `device_id, entry_point_id, interval_start, interval_end, count_in, count_out,
  occupancy, device_reported_at, received_at, raw_payload_hash, clock_flag, revision`;

function toStoredReading(row: ReadingRow): StoredReading {
  return {
    deviceId: row.device_id,
    entryPointId: row.entry_point_id,
    intervalStart: iso(row.interval_start),
    intervalEnd: iso(row.interval_end),
    countIn: Number(row.count_in),
    countOut: Number(row.count_out),
    occupancy: row.occupancy === null ? null : Number(row.occupancy),
    deviceReportedAt: iso(row.device_reported_at),
    receivedAt: iso(row.received_at),
    rawPayloadHash: row.raw_payload_hash,
    flag: row.clock_flag,
    revision: Number(row.revision),
  };
}

function parseLineEntryPoints(text: string): Record<string, string> {
  const value: unknown = JSON.parse(text);
  const out: Record<string, string> = {};
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [line, entry] of Object.entries(value)) {
      if (typeof entry === 'string') out[line] = entry;
    }
  }
  return out;
}

async function insertEvent(tx: SqlExecutor, event: IngestEventToStore): Promise<void> {
  await tx.query(
    `insert into counter_ingest_events (venue_id, device_id, event_type, occurred_at, detail)
     values ($1::text, $2::text, $3::text, $4::timestamptz, $5::text::jsonb)`,
    [event.venueId, event.deviceId, event.type, event.occurredAt, JSON.stringify(event.detail)],
  );
}

async function insertRaw(tx: SqlExecutor, raw: RawPayloadToStore): Promise<boolean> {
  const rows = await tx.query<{ id: unknown }>(
    `insert into counter_raw_payloads
       (venue_id, device_id, provider, payload_hash, payload, received_at, parse_status, error_code,
        metadata)
     values ($1::text, $2::text, $3::text, $4::text, $5::text::jsonb, $6::timestamptz, $7::text, $8::text,
             $9::text::jsonb)
     on conflict (device_id, payload_hash) do nothing
     returning id`,
    [
      raw.venueId,
      raw.deviceId,
      raw.provider,
      raw.payloadHash,
      JSON.stringify(raw.payload),
      raw.receivedAt,
      raw.parseStatus,
      raw.errorCode,
      JSON.stringify({ stripped_keys: raw.strippedKeys }),
    ],
  );
  return rows.length > 0;
}

export class PostgresIngestRepository implements IngestRepository {
  constructor(private readonly db: SqlClient) {}

  async findDevice(provider: string, deviceId: string): Promise<DeviceRecord | null> {
    const rows = await this.db.query<DeviceRow>(
      `select d.device_id, d.provider, d.venue_id, d.entry_point_id,
              d.line_entry_points::text as line_entry_points, d.vendor_serial, d.active,
              array_to_json(c.secret_hashes)::text as secret_hashes
         from counter_devices d
         join counter_device_credentials c
           on c.device_id = d.device_id and c.venue_id = d.venue_id
        where d.device_id = $1::text and d.provider = $2::text`,
      [deviceId, provider],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const hashes: unknown = JSON.parse(row.secret_hashes);
    return {
      provider: row.provider,
      deviceId: row.device_id,
      venueId: row.venue_id,
      entryPointId: row.entry_point_id,
      lineEntryPoints: parseLineEntryPoints(row.line_entry_points),
      vendorSerial: row.vendor_serial,
      active: row.active,
      secretHashes: Array.isArray(hashes)
        ? hashes.filter((h): h is string => typeof h === 'string')
        : [],
    };
  }

  ingest(batch: IngestBatch): Promise<IngestBatchResult> {
    return this.db.transaction(async (tx) => {
      const rawStored = await insertRaw(tx, batch.raw);
      const outcomes: ReadingOutcome[] = [];

      for (const r of batch.readings) {
        const inserted = await tx.query<{ id: unknown }>(
          `insert into counter_readings
             (venue_id, device_id, entry_point_id, source_line, interval_start, interval_end,
              count_in, count_out, occupancy, device_reported_at, received_at, raw_payload_hash,
              clock_flag)
           values ($1::text, $2::text, $3::text, $4::text, $5::timestamptz, $6::timestamptz,
                   $7::integer, $8::integer, $9::integer, $10::timestamptz, $11::timestamptz,
                   $12::text, $13::text)
           on conflict on constraint counter_readings_natural_key do nothing
           returning id`,
          [
            r.venueId,
            r.deviceId,
            r.entryPointId,
            r.sourceLine,
            r.intervalStart,
            r.intervalEnd,
            r.countIn,
            r.countOut,
            r.occupancy,
            r.deviceReportedAt,
            r.receivedAt,
            r.rawPayloadHash,
            r.flag,
          ],
        );
        if (inserted.length > 0) {
          outcomes.push({ kind: 'accepted' });
          continue;
        }

        const locked = await tx.query<ReadingRow>(
          `select ${READING_COLUMNS}
             from counter_readings
            where device_id = $1::text and entry_point_id = $2::text
              and interval_start = $3::timestamptz and interval_end = $4::timestamptz
            for update`,
          [r.deviceId, r.entryPointId, r.intervalStart, r.intervalEnd],
        );
        const row = locked[0];
        if (row === undefined) throw new Error('reading vanished during upsert');
        const existing = toStoredReading(row);
        const decision = decideReading(existing, r);
        if (decision === 'duplicate') {
          outcomes.push({ kind: 'duplicate' });
          continue;
        }
        await insertEvent(tx, conflictEvent(existing, r, decision));
        if (decision === 'keep_existing') {
          outcomes.push({ kind: 'conflict', resolution: 'kept_existing' });
          continue;
        }
        await tx.query(
          `update counter_readings
              set count_in = $5::integer, count_out = $6::integer, occupancy = $7::integer,
                  device_reported_at = $8::timestamptz, received_at = $9::timestamptz,
                  raw_payload_hash = $10::text, clock_flag = $11::text, source_line = $12::text,
                  revision = revision + 1, updated_at = now()
            where device_id = $1::text and entry_point_id = $2::text
              and interval_start = $3::timestamptz and interval_end = $4::timestamptz`,
          [
            r.deviceId,
            r.entryPointId,
            r.intervalStart,
            r.intervalEnd,
            r.countIn,
            r.countOut,
            r.occupancy,
            r.deviceReportedAt,
            r.receivedAt,
            r.rawPayloadHash,
            r.flag,
            r.sourceLine,
          ],
        );
        outcomes.push({ kind: 'conflict', resolution: 'replaced' });
      }

      for (const event of batch.events) await insertEvent(tx, event);
      const result = { rawStored, outcomes };
      if (batch.summary) await insertEvent(tx, batch.summary(result));
      return result;
    });
  }

  rejectPayload(raw: RawPayloadToStore, event: IngestEventToStore): Promise<void> {
    return this.db.transaction(async (tx) => {
      await insertRaw(tx, raw);
      await insertEvent(tx, event);
    });
  }

  async recordEvent(event: IngestEventToStore): Promise<void> {
    await insertEvent(this.db, event);
  }

  async listReadings(deviceId: string): Promise<StoredReading[]> {
    const rows = await this.db.query<ReadingRow>(
      `select ${READING_COLUMNS} from counter_readings
        where device_id = $1::text order by interval_start, entry_point_id`,
      [deviceId],
    );
    return rows.map(toStoredReading);
  }

  async listRawPayloads(deviceId: string): Promise<StoredRawPayload[]> {
    const rows = await this.db.query<{
      payload_hash: string;
      payload: string;
      parse_status: StoredRawPayload['parseStatus'];
      error_code: string | null;
      metadata: string;
    }>(
      `select payload_hash, payload::text as payload, parse_status, error_code,
              metadata::text as metadata
         from counter_raw_payloads where device_id = $1::text order by id`,
      [deviceId],
    );
    return rows.map((row) => {
      const metadata = JSON.parse(row.metadata) as { stripped_keys?: unknown };
      return {
        payloadHash: row.payload_hash,
        payload: JSON.parse(row.payload) as unknown,
        parseStatus: row.parse_status,
        errorCode: row.error_code,
        strippedKeys: Array.isArray(metadata.stripped_keys)
          ? metadata.stripped_keys.filter((k): k is string => typeof k === 'string')
          : [],
      };
    });
  }

  async listEvents(deviceId: string): Promise<IngestEventToStore[]> {
    const rows = await this.db.query<EventRow>(
      `select venue_id, device_id, event_type, occurred_at, detail::text as detail
         from counter_ingest_events where device_id = $1::text order by id`,
      [deviceId],
    );
    return rows.map((row) => ({
      venueId: row.venue_id,
      deviceId: row.device_id,
      type: row.event_type,
      occurredAt: iso(row.occurred_at),
      detail: JSON.parse(row.detail) as IngestEventToStore['detail'],
    }));
  }
}

/** Minimal shape of the `postgres` (postgres.js) driver that we use. */
export interface PostgresJsLike {
  unsafe(text: string, params?: unknown[]): PromiseLike<unknown>;
  begin<T>(work: (tx: PostgresJsLike) => Promise<T>): PromiseLike<unknown>;
}

function executorFor(sql: PostgresJsLike): SqlExecutor {
  return {
    async query<T extends object>(text: string, params: readonly unknown[] = []) {
      // `unsafe` here means "SQL text is not a tagged template"; values still
      // travel as bound parameters, never as SQL text.
      return (await sql.unsafe(text, [...params])) as T[];
    },
  };
}

/** Wrap a postgres.js instance. */
export function fromPostgresJs(sql: PostgresJsLike): SqlClient {
  return {
    ...executorFor(sql),
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return (await sql.begin((tx) => work(executorFor(tx)))) as T;
    },
  };
}
