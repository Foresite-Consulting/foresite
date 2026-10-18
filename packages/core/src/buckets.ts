/**
 * Intervals and bucketing: trading day × section × 15-minute or hourly
 * interval, in the venue's local time.
 *
 * ## The rules
 *
 * - Intervals are **wall-clock aligned** in local time: 15-minute intervals
 *   start at :00, :15, :30 and :45; hourly intervals on the hour. Half-hour
 *   zones (Adelaide, Lord Howe Island) align to their own local clock.
 * - An interval never spans a change of UTC offset or a trading-day
 *   boundary; it is cut short there. So:
 *   - a **repeated** hour (clocks go back) gives two distinct intervals with
 *     the same local clock label, told apart by their UTC start;
 *   - a **skipped** hour (clocks go forward) gives no interval;
 *   - on Lord Howe Island, where the clocks move 30 minutes, an hourly
 *     interval can be 30 minutes long.
 * - Intervals are half-open `[start, end)`. Every instant of a trading day is
 *   in exactly one of that day's intervals, and they tile the day exactly.
 * - A bucket is keyed by trading day, section and interval UTC start.
 */
import { Temporal } from '@js-temporal/polyfill';
import { addDays, type TradingDay } from './time/dates';
import {
  formatLocal,
  formatUtc,
  toEpochMs,
  transitionsBetween,
  zoned,
  type InstantInput,
} from './time/instant';
import { cacheFor, dayStartMs, memo, placedSessions, tradingDayOfMs } from './trading-day';
import type { Venue } from './venue/schema';

/** Supported interval lengths, minutes. */
export const INTERVAL_MINUTES = [15, 60] as const;
export type IntervalMinutes = (typeof INTERVAL_MINUTES)[number];

/** One interval of a trading day. */
export interface TradingInterval {
  readonly tradingDay: TradingDay;
  readonly intervalMinutes: IntervalMinutes;
  /** Inclusive start, ISO 8601 UTC. The key that tells a repeated hour apart. */
  readonly startUtc: string;
  /** Exclusive end, ISO 8601 UTC. */
  readonly endUtc: string;
  /** Elapsed minutes; less than `intervalMinutes` where cut short. */
  readonly durationMinutes: number;
  /** Local wall-clock start with its UTC offset, e.g. `2026-04-05T02:00+10:00`. */
  readonly localStart: string;
  /** The aligned local clock slot, `HH:MM`, e.g. `02:00` (shared by both copies of a repeated hour). */
  readonly slot: string;
}

/** Internal interval with epoch milliseconds. */
interface MsInterval extends TradingInterval {
  readonly startMs: number;
  readonly endMs: number;
}

function assertIntervalMinutes(value: number): asserts value is IntervalMinutes {
  if (!(INTERVAL_MINUTES as readonly number[]).includes(value)) {
    throw new RangeError(`intervalMinutes must be 15 or 60, got ${value}`);
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function buildIntervals(
  venue: Venue,
  day: TradingDay,
  intervalMinutes: IntervalMinutes,
): readonly MsInterval[] {
  const startMs = dayStartMs(venue, day);
  const endMs = dayStartMs(venue, addDays(day, 1));
  const transitions = transitionsBetween(startMs, endMs, venue.timeZone);
  const intervals: MsInterval[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const local = zoned(cursor, venue.timeZone);
    const minuteOfDay = local.hour * 60 + local.minute;
    const slotMinutes = Math.floor(minuteOfDay / intervalMinutes) * intervalMinutes;
    // The next aligned clock boundary, read at the current UTC offset.
    const boundary = local
      .toPlainDate()
      .toPlainDateTime()
      .add({ minutes: slotMinutes + intervalMinutes });
    const alignedEnd = Temporal.ZonedDateTime.from(
      {
        year: boundary.year,
        month: boundary.month,
        day: boundary.day,
        hour: boundary.hour,
        minute: boundary.minute,
        timeZone: venue.timeZone,
        offset: local.offset,
      },
      { offset: 'use' },
    ).epochMilliseconds;
    const nextTransition = transitions.find((t) => t > cursor) ?? Number.POSITIVE_INFINITY;
    const next = Math.min(alignedEnd, endMs, nextTransition);
    intervals.push({
      tradingDay: day,
      intervalMinutes,
      startUtc: formatUtc(cursor),
      endUtc: formatUtc(next),
      durationMinutes: (next - cursor) / 60_000,
      localStart: formatLocal(cursor, venue.timeZone),
      slot: `${pad2(Math.floor(slotMinutes / 60))}:${pad2(slotMinutes % 60)}`,
      startMs: cursor,
      endMs: next,
    });
    cursor = next;
  }
  return intervals;
}

function msIntervals(
  venue: Venue,
  day: TradingDay,
  intervalMinutes: IntervalMinutes,
): readonly MsInterval[] {
  const cache = cacheFor(venue).extra as Map<string, readonly MsInterval[]>;
  return memo(cache, `intervals|${day}|${intervalMinutes}`, () =>
    buildIntervals(venue, day, intervalMinutes),
  );
}

function strip(interval: MsInterval): TradingInterval {
  const { startMs: _start, endMs: _end, ...rest } = interval;
  return rest;
}

/**
 * Every interval of a trading day, in order. They tile the day: the first
 * starts at the day's start, each ends where the next starts, the last ends
 * at the day's end. A normal day has 96 fifteen-minute intervals; a Sydney
 * day when the clocks go forward has 92, and 100 when they go back.
 */
export function tradingDayIntervals(
  tradingDay: TradingDay,
  venue: Venue,
  intervalMinutes: IntervalMinutes,
): readonly TradingInterval[] {
  assertIntervalMinutes(intervalMinutes);
  return msIntervals(venue, tradingDay, intervalMinutes).map(strip);
}

function findInterval(intervals: readonly MsInterval[], ms: number): MsInterval {
  // Binary search for the last interval starting at or before `ms`. The
  // caller has already placed `ms` inside this trading day, so one exists.
  let found: MsInterval | undefined;
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = intervals[mid];
    if (candidate !== undefined && candidate.startMs <= ms) {
      found = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  /* v8 ignore next 3 -- unreachable: intervals tile the trading day */
  if (found === undefined || ms >= found.endMs) {
    throw new RangeError(`No interval contains ${formatUtc(ms)}`);
  }
  return found;
}

/** The interval (and trading day) containing an instant. */
export function intervalFor(
  instantUtc: InstantInput,
  venue: Venue,
  intervalMinutes: IntervalMinutes,
): TradingInterval {
  assertIntervalMinutes(intervalMinutes);
  const ms = toEpochMs(instantUtc);
  const day = tradingDayOfMs(venue, ms);
  return strip(findInterval(msIntervals(venue, day, intervalMinutes), ms));
}

/** An interval of one section, with how much of it is inside scheduled hours. */
export interface SectionInterval extends TradingInterval {
  readonly sectionId: string;
  /** Minutes of this interval inside the section's sessions (0 to `durationMinutes`). */
  readonly scheduledMinutes: number;
}

function scheduledMs(
  venue: Venue,
  day: TradingDay,
  sectionId: string,
  start: number,
  end: number,
): number {
  let total = 0;
  for (const placed of placedSessions(venue, day, sectionId)) {
    const overlap = Math.min(end, placed.closeMs) - Math.max(start, placed.openMs);
    if (overlap > 0) total += overlap;
  }
  return total;
}

/**
 * The intervals of a trading day that overlap a section's scheduled hours,
 * with the scheduled minutes in each (an interval at a 22:10 close has 10).
 * Empty on a closed day.
 *
 * @throws RangeError for an unknown section.
 */
export function scheduledIntervals(
  tradingDay: TradingDay,
  venue: Venue,
  sectionId: string,
  intervalMinutes: IntervalMinutes,
): readonly SectionInterval[] {
  assertIntervalMinutes(intervalMinutes);
  // placedSessions validates the section id.
  if (placedSessions(venue, tradingDay, sectionId).length === 0) return [];
  return msIntervals(venue, tradingDay, intervalMinutes).flatMap((interval) => {
    const minutes =
      scheduledMs(venue, tradingDay, sectionId, interval.startMs, interval.endMs) / 60_000;
    return minutes > 0 ? [{ ...strip(interval), sectionId, scheduledMinutes: minutes }] : [];
  });
}

/** An event to bucket: something that happened at an instant in a section. */
export interface BucketEvent {
  readonly at: InstantInput;
  readonly sectionId: string;
  /** Measures to sum, e.g. `{ net_sales_ex_gst_cents: 4550, covers: 2 }`. Must be finite. */
  readonly values?: Readonly<Record<string, number>>;
}

/** Events grouped into one trading day × section × interval. */
export interface Bucket extends SectionInterval {
  /** Number of events. */
  readonly count: number;
  /** Sum of each measure over the bucket's events. */
  readonly totals: Readonly<Record<string, number>>;
}

/**
 * Group events into trading day × section × interval buckets. Only buckets
 * with at least one event are returned, ordered by start, then section.
 * Totals are plain sums, so integer cents stay exact (up to
 * `Number.MAX_SAFE_INTEGER`).
 *
 * @throws RangeError for an invalid instant, an unknown section or a
 *   non-finite value.
 */
export function bucketEvents(
  events: Iterable<BucketEvent>,
  venue: Venue,
  options: { intervalMinutes: IntervalMinutes },
): Bucket[] {
  const { intervalMinutes } = options;
  assertIntervalMinutes(intervalMinutes);
  const cache = cacheFor(venue);
  const buckets = new Map<
    string,
    { interval: MsInterval; sectionId: string; count: number; totals: Map<string, number> }
  >();
  for (const event of events) {
    if (!cache.sections.has(event.sectionId)) {
      throw new RangeError(`Unknown section "${event.sectionId}" for venue "${venue.id}"`);
    }
    const ms = toEpochMs(event.at);
    const day = tradingDayOfMs(venue, ms);
    const interval = findInterval(msIntervals(venue, day, intervalMinutes), ms);
    const key = `${interval.startMs}|${event.sectionId}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { interval, sectionId: event.sectionId, count: 0, totals: new Map() };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    for (const [name, value] of Object.entries(event.values ?? {})) {
      if (!Number.isFinite(value)) {
        throw new RangeError(`Value "${name}" must be a finite number, got ${value}`);
      }
      bucket.totals.set(name, (bucket.totals.get(name) ?? 0) + value);
    }
  }
  return [...buckets.values()]
    .sort(
      (a, b) => a.interval.startMs - b.interval.startMs || a.sectionId.localeCompare(b.sectionId),
    )
    .map(({ interval, sectionId, count, totals }) => ({
      ...strip(interval),
      sectionId,
      scheduledMinutes:
        scheduledMs(venue, interval.tradingDay, sectionId, interval.startMs, interval.endMs) /
        60_000,
      count,
      // A Map, then fromEntries, so a measure named "__proto__" is just a key.
      totals: Object.fromEntries(totals),
    }));
}
