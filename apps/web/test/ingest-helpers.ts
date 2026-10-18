/**
 * Builders for synthetic Milesight VS13x push payloads, shaped from the
 * vendor docs (see packages/connectors/src/counters/milesight/fixtures).
 * Shared by unit, route and Playwright tests. Synthetic data only.
 */

export interface SyntheticLine {
  line: number;
  in: number;
  out: number;
  /** `line_total_data.capacity_counted`; omitted when undefined. */
  capacity?: number;
}

export interface PeriodicOptions {
  /** Interval start (UTC). */
  start: Date;
  minutes?: number;
  lines?: SyntheticLine[];
  serial?: string;
  /** Offset the device reports local time in. Default +08:00 (Perth). */
  offsetMinutes?: number;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `2026-10-17T19:05:00+08:00` for a UTC instant and an offset. */
export function localIso(utc: Date, offsetMinutes = 480): string {
  const local = new Date(utc.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function milesightPeriodic(options: PeriodicOptions): Record<string, unknown> {
  const minutes = options.minutes ?? 5;
  const offset = options.offsetMinutes ?? 480;
  const end = new Date(options.start.getTime() + minutes * 60_000);
  const lines = options.lines ?? [{ line: 1, in: 5, out: 2, capacity: 3 }];
  return {
    _synthetic: 'Synthetic, shaped from vendor docs. Not from any device or venue.',
    device_info: {
      device_name: 'Test counter',
      device_sn: options.serial ?? 'TEST0000000001',
      firmware_version: 'V_135.1.0.9',
      running_time: 1234,
    },
    line_periodic_data: lines.map((l) => ({
      line: l.line,
      line_name: `Line${l.line}`,
      line_uuid: `00000000-0000-0000-0000-00000000000${l.line}`,
      in: l.in,
      out: l.out,
      staff_in: 0,
      staff_out: 0,
    })),
    line_total_data: lines
      .filter((l) => l.capacity !== undefined)
      .map((l) => ({ line: l.line, capacity_counted: l.capacity })),
    time_info: {
      enable_dst: false,
      dst_status: false,
      start_time: localIso(options.start, offset),
      end_time: localIso(end, offset),
      time_zone: 'UTC+8:00 Australia/Perth',
    },
  };
}

export function basicAuth(deviceId: string, secret: string): string {
  return `Basic ${Buffer.from(`${deviceId}:${secret}`, 'utf8').toString('base64')}`;
}

/** Floor a date to the minute, so intervals line up like the device's "On the Dot" mode. */
export function floorToMinutes(date: Date, minutes: number): Date {
  const step = minutes * 60_000;
  return new Date(Math.floor(date.getTime() / step) * step);
}
