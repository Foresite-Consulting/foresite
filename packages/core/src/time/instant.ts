/**
 * Instants (points on the UTC timeline) and the one place where a venue's
 * local wall-clock time is turned into an instant.
 *
 * All time-zone work goes through the Temporal API (`@js-temporal/polyfill`),
 * which reads the IANA time-zone database that ships with Node's ICU. Nothing
 * in this package adds or subtracts UTC offsets by hand.
 */
import { Temporal } from '@js-temporal/polyfill';

/**
 * Anything accepted as an instant:
 * - a `Date` (must be valid);
 * - an ISO 8601 string **with** a `Z` or a numeric UTC offset, e.g.
 *   `2026-10-17T12:00:00Z` or `2026-10-17T20:00:00+08:00`. A string without an
 *   offset is rejected, because a local time on its own is ambiguous. A
 *   bracketed annotation such as `[Australia/Sydney]` is rejected too: the
 *   offset alone fixes the instant, and an annotation that disagrees with it
 *   would be silently ignored.
 *
 * Numbers are **not** accepted. A bare number cannot say whether it is epoch
 * seconds or milliseconds, and taking seconds as milliseconds lands in
 * January 1970 without any error. Convert explicitly with
 * {@link fromEpochMs} (or `new Date(ms)`).
 *
 * Precision is milliseconds. Finer digits in a string are truncated towards
 * the past.
 */
export type InstantInput = Date | string;

/**
 * A `Date` from epoch **milliseconds**, the explicit way to pass a number as
 * an instant. Throws a `RangeError` unless `ms` is a safe integer.
 */
export function fromEpochMs(ms: number): Date {
  if (!Number.isSafeInteger(ms)) {
    throw new RangeError(`Epoch milliseconds must be a safe integer, got ${ms}`);
  }
  return new Date(ms);
}

/** Parse an {@link InstantInput} into epoch milliseconds, or throw a `RangeError`. */
export function toEpochMs(input: InstantInput): number {
  if (input instanceof Date) {
    const ms = input.getTime();
    if (Number.isNaN(ms)) throw new RangeError('Invalid Date');
    return ms;
  }
  if (typeof input === 'number') {
    throw new RangeError(
      `Instant must be a Date or an ISO 8601 string, got the number ${String(input)}. Numbers are ambiguous (seconds or milliseconds?): use fromEpochMs(ms) or new Date(ms).`,
    );
  }
  if (typeof input === 'string') {
    if (input.includes('[')) {
      throw new RangeError(
        `Invalid instant "${input}": remove the bracketed annotation and keep only the Z or UTC offset, e.g. 2026-10-17T12:00:00Z`,
      );
    }
    try {
      return Temporal.Instant.from(input).epochMilliseconds;
    } catch {
      throw new RangeError(
        `Invalid instant "${input}": use ISO 8601 with Z or a UTC offset, e.g. 2026-10-17T12:00:00Z`,
      );
    }
  }
  throw new RangeError('Instant must be a Date or an ISO 8601 string with Z or a UTC offset');
}

/**
 * Format epoch milliseconds as ISO 8601 UTC: `2026-10-17T12:00:00Z`, or
 * `2026-10-17T12:00:00.250Z` when there are milliseconds (always three
 * digits). UTC only, so no time zone is involved.
 */
export function formatUtc(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

/** The instant in the venue's zone. */
export function zoned(epochMs: number, timeZone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
}

/**
 * Turn a local wall-clock time into an instant, the same way every time:
 *
 * - **Normal time** (exists exactly once): that instant.
 * - **Repeated time** (clocks go back, e.g. 02:30 on the first Sunday in
 *   April in Sydney): the **first** occurrence, i.e. still on daylight time.
 * - **Skipped time** (clocks go forward, e.g. 02:30 on the first Sunday in
 *   October in Sydney): the instant the clocks jump, i.e. the first instant
 *   after the gap (03:00 AEDT).
 *
 * This mapping never goes backwards: a later wall-clock time never gives an
 * earlier instant. That is what keeps sessions in order and inside their
 * trading day across a daylight-saving change. (Temporal's own `compatible`
 * rule moves skipped times forward by the length of the gap, so 02:30 would
 * become 03:30, after 03:00; that would break the ordering.)
 *
 * @param date Local calendar date.
 * @param minutesOfDay Minutes after local midnight, 0 to 1439.
 */
export function wallToEpochMs(
  date: Temporal.PlainDate,
  minutesOfDay: number,
  timeZone: string,
): number {
  const wall = date.toPlainDateTime({
    hour: Math.floor(minutesOfDay / 60),
    minute: minutesOfDay % 60,
  });
  const earlier = wall.toZonedDateTime(timeZone, { disambiguation: 'earlier' });
  if (Temporal.PlainDateTime.compare(earlier.toPlainDateTime(), wall) === 0) {
    return earlier.epochMilliseconds;
  }
  // The wall time is in a gap. `earlier` sits just before the gap, so the
  // next transition is the moment the clocks jump.
  const jump = earlier.getTimeZoneTransition('next');
  // Unreachable: a gap always ends in a transition.
  /* v8 ignore next -- @preserve */
  if (jump === null) {
    throw new RangeError(`No time-zone transition after ${earlier.toString()}`);
  }
  return jump.epochMilliseconds;
}

/**
 * Time-zone transitions (offset changes) strictly after `startMs` and strictly
 * before `endMs`, as epoch milliseconds, in order.
 */
export function transitionsBetween(startMs: number, endMs: number, timeZone: string): number[] {
  const found: number[] = [];
  let cursor = zoned(startMs, timeZone).getTimeZoneTransition('next');
  while (cursor !== null && cursor.epochMilliseconds < endMs) {
    found.push(cursor.epochMilliseconds);
    cursor = cursor.getTimeZoneTransition('next');
  }
  return found;
}
