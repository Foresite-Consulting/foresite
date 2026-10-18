/**
 * Venue configuration: sections, weekly trading hours, date exceptions and
 * the trading-day cut-over. Validated with zod; `parseVenue` returns a frozen
 * {@link Venue} that every other function in this package takes.
 *
 * Venue configuration is client data. It lives in the client's database, not
 * in this repo; the only venues here are fictional test venues.
 */
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { WEEKDAYS, isTradingDay, type Weekday } from '../time/dates';

/** Default IANA time zone for a new venue (Foresite's home market). */
export const DEFAULT_TIME_ZONE = 'Australia/Perth';
/** Default trading-day cut-over, local time. */
export const DEFAULT_CUT_OVER = '05:00';
/** Minutes in a day, wall clock. */
export const MINUTES_PER_DAY = 1440;

const MAX_SECTIONS = 50;
const MAX_SESSIONS_PER_DAY = 10;
const MAX_EXCEPTIONS = 5000;

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight for a `HH:MM` clock time. */
export function clockToMinutes(clock: string): number {
  const match = CLOCK_PATTERN.exec(clock);
  if (match === null) throw new RangeError(`Invalid time "${clock}": use 24-hour HH:MM`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Where a clock time falls in a trading day: minutes after the cut-over,
 * 0 to 1439. A time earlier than the cut-over belongs to the next calendar
 * date (it is after midnight).
 */
export function minutesAfterCutOver(clock: string, cutOverMinutes: number): number {
  return (clockToMinutes(clock) - cutOverMinutes + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * A session's open and close as minutes after the cut-over. A close equal to
 * the cut-over is the end of the trading day (1440).
 */
export function sessionOffsets(
  session: Session,
  cutOverMinutes: number,
): { open: number; close: number } {
  const open = minutesAfterCutOver(session.open, cutOverMinutes);
  const closeRaw = minutesAfterCutOver(session.close, cutOverMinutes);
  return { open, close: closeRaw === 0 ? MINUTES_PER_DAY : closeRaw };
}

const slug = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,63}$/,
    'Use lower-case letters, digits, "-" or "_" (max 64), e.g. "bar" or "main-deck"',
  );

const label = z.string().trim().min(1, 'Required').max(100, 'Keep it under 100 characters');

const clockTime = z.string().regex(CLOCK_PATTERN, 'Use 24-hour HH:MM, e.g. 05:00 or 23:30');

const tradingDate = z
  .string()
  .refine(isTradingDay, 'Use a real date written YYYY-MM-DD, e.g. 2026-10-17');

/**
 * One trading session: `open` to `close`, local wall-clock `HH:MM`.
 *
 * A close at or before the open is on the next calendar date (`11:00`–`02:00`
 * closes at 2 am the next morning). Both times must fall inside the same
 * trading day: the session may not cross the venue's cut-over.
 * The session includes its open and excludes its close: `[open, close)`.
 */
export const sessionSchema = z.object({ open: clockTime, close: clockTime }).strict();
export type Session = z.output<typeof sessionSchema>;

const sessionList = z.array(sessionSchema).max(MAX_SESSIONS_PER_DAY);

const weeklyHoursSchema = z
  .object(
    Object.fromEntries(WEEKDAYS.map((day) => [day, sessionList.optional()])) as Record<
      Weekday,
      z.ZodOptional<typeof sessionList>
    >,
  )
  .strict();

/**
 * Trading hours for each weekday, keyed `mon` to `sun`. The weekday is the
 * day the trading day **starts**. A missing day or an empty list means closed.
 */
export type WeeklyHours = Partial<Record<Weekday, readonly Session[]>>;

/** A part of the venue that trades and reports on its own (bar, restaurant, deck, functions…). */
export const sectionSchema = z
  .object({ id: slug, name: label, hours: weeklyHoursSchema.default({}) })
  .strict();

const hoursOverride = z.record(slug, sessionList);

/**
 * A change to the normal week for one trading day.
 *
 * - `closure`: the venue (or only `sectionIds`) does not trade.
 * - `public_holiday`, `event`, `special_hours`: a label for the calendar, plus
 *   optional replacement `hours` per section. A section listed in `hours`
 *   uses those sessions instead of its weekly hours (`[]` closes it); a section
 *   not listed keeps its weekly hours. `special_hours` must list some hours.
 */
export const dateExceptionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('closure'),
      date: tradingDate,
      name: label,
      sectionIds: z.array(slug).min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('public_holiday'),
      date: tradingDate,
      name: label,
      hours: hoursOverride.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('event'),
      date: tradingDate,
      name: label,
      hours: hoursOverride.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('special_hours'),
      date: tradingDate,
      name: label,
      hours: hoursOverride,
    })
    .strict(),
]);
export type DateException = z.output<typeof dateExceptionSchema>;
export type DateExceptionKind = DateException['kind'];

function isIanaZoneName(zone: string): boolean {
  // Reject fixed offsets ("+08:00"), which Temporal accepts but which have no
  // daylight-saving rules and are not IANA names.
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) return false;
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
}

function canonicalZone(zone: string): string {
  // zod runs transforms on input that already has issues, so this must not throw.
  try {
    return Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone).timeZoneId;
  } catch {
    return zone;
  }
}

const isClock = (value: string): boolean => CLOCK_PATTERN.test(value);

function checkSessions(
  sessions: readonly Session[],
  cutOverMinutes: number,
  cutOver: string,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  // Malformed times are reported by the field schema; skip them here.
  const placed = sessions.flatMap((session, index) =>
    isClock(session.open) && isClock(session.close)
      ? [{ session, index, ...sessionOffsets(session, cutOverMinutes) }]
      : [],
  );
  for (const { session, index, open, close } of placed) {
    if (session.open === session.close) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: `Session ${session.open}–${session.close} has the same open and close. Sessions must be shorter than 24 hours.`,
      });
    } else if (close <= open) {
      // The close lands in the next trading day: the session crosses the
      // cut-over. (Offsets are in [0, 1440), closes in (0, 1440], so any
      // session that passes this check is shorter than 24 hours.)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: `Session ${session.open}–${session.close} crosses the trading-day cut-over (${cutOver}). A session must open and close within one trading day; move the cut-over if the venue trades past it.`,
      });
    }
  }
  const valid = placed.filter(({ open, close }) => close > open).sort((a, b) => a.open - b.open);
  for (let i = 1; i < valid.length; i += 1) {
    const before = valid[i - 1];
    const after = valid[i];
    if (before !== undefined && after !== undefined && after.open < before.close) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, after.index],
        message: `Session ${after.session.open}–${after.session.close} overlaps ${before.session.open}–${before.session.close}. Sessions in a section must not overlap (one may start when another closes).`,
      });
    }
  }
}

const venueObjectSchema = z
  .object({
    id: slug,
    name: label,
    /** IANA time-zone name, e.g. `Australia/Perth`. Fixed offsets are rejected. */
    timeZone: z
      .string()
      .default(DEFAULT_TIME_ZONE)
      .refine(isIanaZoneName, 'Use an IANA time zone such as Australia/Perth or Australia/Sydney'),
    /**
     * Local time at which one trading day ends and the next begins, `HH:MM`.
     * Default `05:00`.
     */
    cutOver: clockTime.default(DEFAULT_CUT_OVER),
    sections: z.array(sectionSchema).min(1, 'Add at least one section').max(MAX_SECTIONS),
    exceptions: z.array(dateExceptionSchema).max(MAX_EXCEPTIONS).default([]),
  })
  .strict();

/**
 * The venue configuration schema. Parsing checks, beyond the field formats:
 * unique section ids; sessions that close after they open (allowing a close
 * after midnight), are shorter than 24 hours, stay within one trading day
 * and do not overlap within a section; one exception per date; exceptions
 * only name sections that exist.
 */
export const venueSchema = venueObjectSchema
  .superRefine((venue, ctx) => {
    // zod runs refinements on input that already has issues: a malformed
    // cut-over is reported by its field schema, so stop here.
    if (!isClock(venue.cutOver)) return;
    const cutOverMinutes = clockToMinutes(venue.cutOver);
    const sectionIds = new Set<string>();
    venue.sections.forEach((section, sectionIndex) => {
      if (sectionIds.has(section.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sections', sectionIndex, 'id'],
          message: `Section id "${section.id}" is used twice`,
        });
      }
      sectionIds.add(section.id);
      for (const day of WEEKDAYS) {
        const sessions = section.hours[day];
        if (sessions !== undefined) {
          checkSessions(
            sessions,
            cutOverMinutes,
            venue.cutOver,
            ['sections', sectionIndex, 'hours', day],
            ctx,
          );
        }
      }
    });

    const dates = new Set<string>();
    venue.exceptions.forEach((exception, exceptionIndex) => {
      const path = ['exceptions', exceptionIndex];
      if (dates.has(exception.date)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, 'date'],
          message: `More than one exception for ${exception.date}. Combine them into one.`,
        });
      }
      dates.add(exception.date);
      const named = exception.kind === 'closure' ? (exception.sectionIds ?? []) : [];
      named.forEach((id, i) => {
        if (!sectionIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'sectionIds', i],
            message: `Unknown section "${id}"`,
          });
        }
      });
      if (exception.kind !== 'closure' && exception.hours !== undefined) {
        for (const [id, sessions] of Object.entries(exception.hours)) {
          if (!sectionIds.has(id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, 'hours', id],
              message: `Unknown section "${id}"`,
            });
          }
          checkSessions(sessions, cutOverMinutes, venue.cutOver, [...path, 'hours', id], ctx);
        }
      }
    });
  })
  .transform((venue) =>
    deepFreeze({
      ...venue,
      timeZone: canonicalZone(venue.timeZone),
      exceptions: [...venue.exceptions].sort((a, b) => a.date.localeCompare(b.date)),
    }),
  );

/** Venue configuration as written by a person or loaded from the database (defaults optional). */
export type VenueConfig = z.input<typeof venueSchema>;

/** A section after validation. */
export interface Section {
  readonly id: string;
  readonly name: string;
  readonly hours: WeeklyHours;
}

/**
 * A validated venue: the output of {@link parseVenue}. Deeply frozen, with the
 * time zone in canonical form and exceptions sorted by date.
 */
export interface Venue {
  readonly id: string;
  readonly name: string;
  readonly timeZone: string;
  readonly cutOver: string;
  readonly sections: readonly Section[];
  readonly exceptions: readonly DateException[];
}

/** Validate venue configuration. Throws a `ZodError` listing every problem. */
export function parseVenue(input: unknown): Venue {
  return venueSchema.parse(input);
}

/** Validate venue configuration without throwing. */
export function safeParseVenue(
  input: unknown,
): { success: true; data: Venue } | { success: false; error: z.ZodError } {
  const result = venueSchema.safeParse(input);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
