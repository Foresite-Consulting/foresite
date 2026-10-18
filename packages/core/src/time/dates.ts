/**
 * Trading-day dates, weekdays and the like-for-like comparison helpers.
 */
import { Temporal } from '@js-temporal/polyfill';

/**
 * A trading day, written as the local calendar date on which it **starts**,
 * `YYYY-MM-DD`. A Saturday that opens at 11:00 and closes at 02:00 on Sunday
 * is the trading day `2026-10-17` (the Saturday).
 */
export type TradingDay = string;

/** Weekday keys used in trading hours, Monday first (ISO 8601 order). */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Parse `YYYY-MM-DD` into a `PlainDate`, rejecting impossible dates such as `2026-02-30`. */
export function parseTradingDay(day: string): Temporal.PlainDate {
  if (!DATE_PATTERN.test(day)) {
    throw new RangeError(`Invalid trading day "${day}": use YYYY-MM-DD, e.g. 2026-10-17`);
  }
  try {
    return Temporal.PlainDate.from(day, { overflow: 'reject' });
  } catch {
    throw new RangeError(`Invalid trading day "${day}": no such date`);
  }
}

/** True when `day` is a real calendar date written as `YYYY-MM-DD`. */
export function isTradingDay(day: unknown): day is TradingDay {
  if (typeof day !== 'string') return false;
  try {
    parseTradingDay(day);
    return true;
  } catch {
    return false;
  }
}

/** `day` plus `days` calendar days (negative to go back). */
export function addDays(day: TradingDay, days: number): TradingDay {
  if (!Number.isSafeInteger(days)) throw new RangeError(`days must be an integer, got ${days}`);
  return parseTradingDay(day).add({ days }).toString();
}

/** Whole calendar days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: TradingDay, to: TradingDay): number {
  return parseTradingDay(from).until(parseTradingDay(to), { largestUnit: 'day' }).days;
}

/** The weekday a trading day starts on. */
export function weekdayOf(day: TradingDay): Weekday {
  // dayOfWeek is 1 (Monday) to 7 (Sunday) in the ISO calendar.
  const weekday = WEEKDAYS[parseTradingDay(day).dayOfWeek - 1];
  /* v8 ignore next -- unreachable: the ISO calendar has seven weekdays */
  if (weekday === undefined) throw new RangeError(`No weekday for ${day}`);
  return weekday;
}

/**
 * The same weekday last year: exactly **364 days (52 weeks) earlier**.
 *
 * This is the like-for-like comparison hospitality uses: a Saturday is
 * compared with a Saturday. The calendar date drifts by one day a year (two
 * after 29 February), so after about five years the comparison day sits a
 * week early against the calendar; that is accepted.
 *
 * `sameWeekdayLastYear('2026-10-17')` → `'2025-10-18'` (both Saturdays).
 */
export function sameWeekdayLastYear(day: TradingDay): TradingDay {
  return addDays(day, -364);
}

/**
 * The same calendar date last year, for reference (not like-for-like on
 * weekday). 29 February maps to 28 February.
 *
 * `sameDateLastYear('2028-02-29')` → `'2027-02-28'`.
 */
export function sameDateLastYear(day: TradingDay): TradingDay {
  return parseTradingDay(day).subtract({ years: 1 }, { overflow: 'constrain' }).toString();
}
