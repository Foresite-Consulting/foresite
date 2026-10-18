/**
 * Strict ISO 8601 timestamp parsing for device payloads.
 *
 * Devices report local time with an explicit offset (Milesight:
 * `2024-05-30T12:26:00+08:00`). A timestamp without an offset is ambiguous,
 * so it is rejected rather than guessed. Calendar fields are range-checked so
 * that `2024-02-30` is not silently rolled over to 1 March.
 */

const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Parse to epoch milliseconds, or `null` if the string is not a valid timestamp with offset. */
export function parseOffsetTimestamp(value: string): number | null {
  const match = ISO_WITH_OFFSET.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac, zone, sign, oh, om] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offH = Number(oh);
    const offM = Number(om);
    if (offH > 14 || offM > 59) return null;
    offsetMinutes = (sign === '-' ? -1 : 1) * (offH * 60 + offM);
  }
  const millis = frac === undefined ? 0 : Math.floor(Number(`0.${frac}`) * 1000);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000;
  return Number.isFinite(utc) ? utc : null;
}

export function toUtcIso(epochMillis: number): string {
  return new Date(epochMillis).toISOString();
}
