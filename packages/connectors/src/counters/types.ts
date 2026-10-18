/**
 * Vendor-neutral people-counter model.
 *
 * Every counter adapter (Milesight first; others later) turns a vendor push
 * payload into `CounterReading`s. Timestamps are ISO 8601 strings in UTC.
 * Trading-day assignment is NOT done here: the trading-day model lives in
 * `packages/core` and joins on `intervalStart`/`intervalEnd` later, using the
 * venue's timezone.
 */

/** What the ingest endpoint knows about the authenticated device. */
export interface CounterDeviceContext {
  /** Provider key, e.g. `milesight`. */
  provider: string;
  /** Foresite device id. Also the HTTP Basic username the device sends. */
  deviceId: string;
  venueId: string;
  /** Entry point (door, gate) this device watches. Used for line 1. */
  entryPointId: string;
  /**
   * Optional per-line entry points, keyed by the vendor's line number as a
   * string (`"2"`). Lines without an entry fall back to the rule in
   * `resolveEntryPointId`.
   */
  lineEntryPoints: Readonly<Record<string, string>>;
  /** Vendor serial number registered for this device, if known. */
  vendorSerial: string | null;
}

/** One interval of line-crossing counts at one entry point. */
export interface CounterReading {
  provider: string;
  deviceId: string;
  venueId: string;
  entryPointId: string;
  /** Vendor line reference (Milesight line number), for traceability. */
  sourceLine: string;
  /** Interval start, ISO 8601 UTC. */
  intervalStart: string;
  /** Interval end, ISO 8601 UTC. Always after `intervalStart`. */
  intervalEnd: string;
  /** People who crossed inwards during the interval. */
  countIn: number;
  /** People who crossed outwards during the interval. */
  countOut: number;
  /** People inside according to the device, if it reports it. */
  occupancy: number | null;
  /**
   * The device's own timestamp for this reading, ISO 8601 UTC. Used to pick a
   * winner when the same interval arrives twice with different counts.
   */
  deviceReportedAt: string;
  /** When our endpoint received the request, ISO 8601 UTC. */
  receivedAt: string;
  /** SHA-256 (hex) of the exact request body the reading came from. */
  rawPayloadHash: string;
}

/** Something worth recording that is not a reading (alarms, ignored reports). */
export interface CounterDeviceEvent {
  type: 'device_alarm' | 'report_ignored';
  /** Only fixed vocabulary or numbers; never free text copied from the payload. */
  detail: Readonly<Record<string, string | number | boolean>>;
}

export type CounterReportType =
  | 'line_periodic'
  | 'line_trigger'
  | 'region_periodic'
  | 'region_trigger'
  | 'occlusion_alarm'
  | 'unrecognised';

export interface CounterMapResult {
  readings: CounterReading[];
  events: CounterDeviceEvent[];
  reportTypes: CounterReportType[];
  /** Vendor serial number(s) found in the payload. */
  vendorSerials: string[];
}

/** Safe, fixed error codes. They never contain payload content. */
export type CounterPayloadErrorCode =
  | 'invalid_payload'
  | 'missing_interval'
  | 'invalid_timestamp'
  | 'invalid_interval'
  | 'duplicate_line'
  /** Two lines in one report resolve to the same entry point (would overwrite counts). */
  | 'duplicate_entry_point'
  | 'too_many_reports';

export type CounterMapOutcome =
  | { ok: true; value: CounterMapResult }
  | {
      ok: false;
      code: CounterPayloadErrorCode;
      /** Schema paths (field names and indexes only) for logs. Never values. */
      paths: string[];
    };

export interface CounterMapInput {
  /** The request body after `JSON.parse`. */
  body: unknown;
  device: CounterDeviceContext;
  receivedAt: string;
  rawPayloadHash: string;
}

export interface CounterAdapter {
  /** Provider key used in the ingest URL: `/api/ingest/counters/<provider>`. */
  readonly provider: string;
  map(input: CounterMapInput): CounterMapOutcome;
}

/**
 * Entry point for a vendor line. Explicit per-line mapping wins; line 1 falls
 * back to the device's entry point; any other line gets a deterministic id
 * `<entryPointId>:line-<n>` so its counts are never merged into line 1.
 */
export function resolveEntryPointId(device: CounterDeviceContext, line: string): string {
  const mapped = device.lineEntryPoints[line];
  if (mapped !== undefined && mapped !== '') return mapped;
  return line === '1' ? device.entryPointId : `${device.entryPointId}:line-${line}`;
}
