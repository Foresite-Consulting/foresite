/**
 * Structured ingest logs: one JSON line per request.
 *
 * Fields are an allow-list. No secrets, no Authorization header, no request
 * bodies and no free text from payloads. A device id is logged only once the
 * device has authenticated; for failed attempts we log whether the claimed id
 * was well-formed, never the id itself (a mistyped secret pasted into the
 * username field would otherwise end up in the logs).
 */

export interface IngestLogEntry {
  provider: string;
  outcome: string;
  status: number;
  deviceId?: string;
  /** Which rotation slot the secret matched (1 or 2). */
  secretSlot?: number;
  errorCode?: string;
  /** Schema field paths for validation failures. No values. */
  paths?: string[];
  counts?: Record<string, number>;
  reportTypes?: string[];
  durationMs?: number;
  requestId?: string;
}

export type IngestLogger = (entry: IngestLogEntry) => void;

export const consoleIngestLogger: IngestLogger = (entry) => {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: entry.status >= 500 ? 'error' : entry.status >= 400 ? 'warn' : 'info',
    event: 'counter_ingest',
    ...entry,
  });
  if (entry.status >= 500) console.error(line);
  else if (entry.status >= 400) console.warn(line);
  else console.info(line);
};

export const silentIngestLogger: IngestLogger = () => undefined;
