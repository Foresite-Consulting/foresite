import type { ZodError } from 'zod';
import { parseOffsetTimestamp, toUtcIso } from '../timestamps';
import {
  resolveEntryPointId,
  type CounterAdapter,
  type CounterDeviceEvent,
  type CounterMapInput,
  type CounterMapOutcome,
  type CounterReading,
  type CounterReportType,
} from '../types';
import { minimiseMilesightPayload } from './minimise';
import { MAX_REPORTS_PER_REQUEST, milesightReportSchema, type MilesightReport } from './schema';

export const MILESIGHT_PROVIDER = 'milesight';

/** Longest interval we accept. The device's longest documented period is on-the-hour. */
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Failure = Extract<CounterMapOutcome, { ok: false }>;

function fail(code: Failure['code'], paths: string[] = []): Failure {
  return { ok: false, code, paths };
}

/** Field paths only (keys from our schema and array indexes). Never values. */
function issuePaths(error: ZodError, prefix: string): string[] {
  return error.issues
    .slice(0, 5)
    .map((issue) => [prefix, ...issue.path.map(String)].filter((part) => part !== '').join('.'));
}

function reportTypesOf(report: MilesightReport): CounterReportType[] {
  const types: CounterReportType[] = [];
  if (report.line_periodic_data !== undefined) types.push('line_periodic');
  if (report.line_trigger_data !== undefined) types.push('line_trigger');
  if (report.region_data !== undefined) types.push('region_periodic');
  if (report.region_trigger_data !== undefined) types.push('region_trigger');
  if (report.tof_occlusion_trigger !== undefined) types.push('occlusion_alarm');
  if (types.length === 0) types.push('unrecognised');
  return types;
}

function occlusionStatus(value: string): 'occluded' | 'other' {
  return value === 'occluded' ? 'occluded' : 'other';
}

/**
 * Map one validated report. Only `line_periodic_data` becomes readings:
 * trigger reports carry the same crossings as the periodic report that
 * follows, so storing both would double count. Region data is not an entry
 * point and is kept only in the raw staging table for now.
 */
function mapReport(
  report: MilesightReport,
  index: number,
  input: CounterMapInput,
): { readings: CounterReading[]; events: CounterDeviceEvent[] } | Failure {
  const prefix = `[${index}]`;
  const readings: CounterReading[] = [];
  const events: CounterDeviceEvent[] = [];

  if (report.tof_occlusion_trigger !== undefined) {
    events.push({
      type: 'device_alarm',
      detail: {
        alarm: 'occlusion',
        status: occlusionStatus(report.tof_occlusion_trigger.occlusion_status),
      },
    });
  }

  const lines = report.line_periodic_data;
  if (lines === undefined) {
    for (const type of reportTypesOf(report)) {
      if (type !== 'occlusion_alarm') events.push({ type: 'report_ignored', detail: { type } });
    }
    return { readings, events };
  }

  const { start_time: start, end_time: end } = report.time_info;
  if (start === undefined || end === undefined) {
    return fail('missing_interval', [
      `${prefix}.time_info.start_time`,
      `${prefix}.time_info.end_time`,
    ]);
  }
  const startMs = parseOffsetTimestamp(start);
  const endMs = parseOffsetTimestamp(end);
  if (startMs === null || endMs === null) {
    return fail('invalid_timestamp', [
      `${prefix}.time_info.${startMs === null ? 'start_time' : 'end_time'}`,
    ]);
  }
  if (endMs <= startMs || endMs - startMs > MAX_INTERVAL_MS) {
    return fail('invalid_interval', [`${prefix}.time_info`]);
  }

  const occupancyByLine = new Map<number, number>();
  for (const total of report.line_total_data ?? []) {
    if (total.capacity_counted !== undefined && total.capacity_counted >= 0) {
      occupancyByLine.set(total.line, total.capacity_counted);
    }
  }

  const seen = new Set<number>();
  const entryPoints = new Set<string>();
  for (const [lineIndex, line] of lines.entries()) {
    if (seen.has(line.line)) {
      return fail('duplicate_line', [`${prefix}.line_periodic_data.${lineIndex}.line`]);
    }
    seen.add(line.line);
    const sourceLine = String(line.line);
    const entryPointId = resolveEntryPointId(input.device, sourceLine);
    // Readings are unique per entry point and interval, so a second line on
    // the same entry point would silently overwrite the first one's counts.
    if (entryPoints.has(entryPointId)) {
      return fail('duplicate_entry_point', [`${prefix}.line_periodic_data.${lineIndex}.line`]);
    }
    entryPoints.add(entryPointId);
    readings.push({
      provider: MILESIGHT_PROVIDER,
      deviceId: input.device.deviceId,
      venueId: input.device.venueId,
      entryPointId,
      sourceLine,
      intervalStart: toUtcIso(startMs),
      intervalEnd: toUtcIso(endMs),
      countIn: line.in,
      countOut: line.out,
      occupancy: occupancyByLine.get(line.line) ?? null,
      // The periodic report has no separate "generated at" time, so the
      // interval end is the device's timestamp for the reading.
      deviceReportedAt: toUtcIso(endMs),
      receivedAt: input.receivedAt,
      rawPayloadHash: input.rawPayloadHash,
    });
  }
  return { readings, events };
}

export function mapMilesightPayload(input: CounterMapInput): CounterMapOutcome {
  const reports: unknown[] = Array.isArray(input.body) ? input.body : [input.body];
  if (reports.length === 0) return fail('invalid_payload', ['[]']);
  if (reports.length > MAX_REPORTS_PER_REQUEST) return fail('too_many_reports');

  const readings: CounterReading[] = [];
  const events: CounterDeviceEvent[] = [];
  const reportTypes = new Set<CounterReportType>();
  const vendorSerials = new Set<string>();

  for (const [index, candidate] of reports.entries()) {
    const parsed = milesightReportSchema.safeParse(candidate);
    if (!parsed.success) return fail('invalid_payload', issuePaths(parsed.error, `[${index}]`));
    const report = parsed.data;
    vendorSerials.add(report.device_info.device_sn);
    for (const type of reportTypesOf(report)) reportTypes.add(type);

    const mapped = mapReport(report, index, input);
    if ('ok' in mapped) return mapped;
    readings.push(...mapped.readings);
    events.push(...mapped.events);
  }

  return {
    ok: true,
    value: {
      readings,
      events,
      reportTypes: [...reportTypes],
      vendorSerials: [...vendorSerials],
    },
  };
}

export const milesightAdapter: CounterAdapter = {
  provider: MILESIGHT_PROVIDER,
  minimise: minimiseMilesightPayload,
  map: mapMilesightPayload,
};
