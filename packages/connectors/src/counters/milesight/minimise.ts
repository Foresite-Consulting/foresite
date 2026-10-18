import type { CounterMinimiseResult } from '../types';

/**
 * Data minimisation for Milesight payloads, applied before the body is
 * stored in the raw staging table (and before mapping).
 *
 * Counting needs none of the device's network or SIM identifiers, so they
 * are dropped wherever they appear: the whole `network_info` block (ICCID,
 * IMEI, cell ID, LAC; D5 3.4 "networkInfo"), `device_info.device_mac` and
 * `ip_address` (D2), `nodeDeviceInfo` (UNVERIFIED: multi-device stitching
 * payloads; dropped in case it carries the same identifiers per node), and
 * any stray SIM or network identifier key. Keys are matched case-insensitively
 * with underscores ignored, so `cellId`, `cell_id` and `CELL_ID` all match.
 *
 * Only the names of the keys removed are kept (in the raw row's metadata),
 * never their values.
 */

const STRIPPED = new Set([
  'networkinfo',
  'nodedeviceinfo',
  'devicemac',
  'mac',
  'macaddress',
  'ipaddress',
  'iccid',
  'imei',
  'imsi',
  'msisdn',
  'cellid',
  'lac',
]);

/** At most this many distinct key names are listed. */
const MAX_LISTED = 32;

export function isStrippedKey(key: string): boolean {
  return STRIPPED.has(key.toLowerCase().replaceAll('_', ''));
}

function strip(value: unknown, removed: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => strip(item, removed));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isStrippedKey(key)) {
      if (removed.size < MAX_LISTED) removed.add(key.slice(0, 64));
      continue;
    }
    // defineProperty, so a key named `__proto__` stays an ordinary key.
    Object.defineProperty(out, key, {
      value: strip(item, removed),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * A copy of the body without network and SIM identifiers, plus the sorted
 * names of the keys removed. Expects a body already checked for depth (the
 * ingest handler refuses anything deeper than 32 levels first).
 */
export function minimiseMilesightPayload(body: unknown): CounterMinimiseResult {
  const removed = new Set<string>();
  const payload = strip(body, removed);
  return { payload, strippedKeys: [...removed].sort() };
}
