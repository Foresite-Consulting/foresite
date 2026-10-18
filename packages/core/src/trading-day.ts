/**
 * The trading-day model: which trading day (and whether scheduled hours) an
 * instant belongs to, and the UTC bounds of a trading day and its sessions.
 *
 * ## The rules
 *
 * 1. A **trading day** is named by the local date it starts on (`YYYY-MM-DD`).
 * 2. Trading day D runs from the **cut-over** on local date D (default 05:00)
 *    to the cut-over on local date D+1: a half-open window `[start, end)`.
 *    Every instant belongs to exactly one trading day, and the end of D is
 *    the start of D+1. The window is 24 hours long, or 23 / 25 hours (23.5 /
 *    24.5 on Lord Howe Island) on a night the clocks change.
 * 3. **Sessions** (scheduled hours) sit inside their trading day's window:
 *    validation rejects any session that crosses the cut-over. So "the
 *    session's trading day" and "the trading day by cut-over" are always the
 *    same day, and an instant outside every session still has a trading day.
 * 4. A session is `[open, close)`: the open instant is inside, the close
 *    instant is not. Two sessions may touch (lunch closes at 15:00, a session
 *    opens at 15:00).
 * 5. Local times become instants by one rule (see `wallToEpochMs`): a
 *    repeated time takes its first occurrence; a skipped time takes the
 *    moment the clocks jump. A session whose open and close both fall in a
 *    skipped hour has no length that night and is left out.
 * 6. Hours for trading day D and a section: a `closure` exception for D that
 *    covers the section closes it; otherwise exception hours for that section
 *    replace the weekly hours; otherwise the weekly hours for D's weekday.
 */
import { addDays, parseTradingDay, weekdayOf, type TradingDay } from './time/dates';
import { formatUtc, toEpochMs, wallToEpochMs, zoned, type InstantInput } from './time/instant';
import {
  MINUTES_PER_DAY,
  clockToMinutes,
  sessionOffsets,
  type DateException,
  type Section,
  type Session,
  type Venue,
} from './venue/schema';

/** A session placed on the UTC timeline. */
export interface ScheduledSession {
  readonly sectionId: string;
  /** Local open time as configured, `HH:MM`. */
  readonly open: string;
  /** Local close time as configured, `HH:MM` (may be after midnight). */
  readonly close: string;
  /** Open instant, ISO 8601 UTC. Inside the session. */
  readonly openUtc: string;
  /** Close instant, ISO 8601 UTC. Not inside the session. */
  readonly closeUtc: string;
  /** Elapsed minutes from open to close (not wall-clock minutes). */
  readonly durationMinutes: number;
}

/** UTC bounds of one trading day and of its scheduled sessions. */
export interface TradingDayBounds {
  readonly tradingDay: TradingDay;
  /** Start of the trading day (the cut-over on that date), ISO 8601 UTC, inclusive. */
  readonly startUtc: string;
  /** End of the trading day (the next cut-over), ISO 8601 UTC, exclusive. */
  readonly endUtc: string;
  /** Elapsed minutes: 1440 normally, 1380 or 1500 when the clocks change. */
  readonly durationMinutes: number;
  /** The date exception that applies, if any. */
  readonly exception: DateException | null;
  /** Sessions, ordered by open then section id. Only the requested section if one was given. */
  readonly sessions: readonly ScheduledSession[];
}

/** Where an instant falls. */
export interface TradingDayAssignment {
  readonly tradingDay: TradingDay;
  /** The section asked about, or `null` when the question was for the whole venue. */
  readonly sectionId: string | null;
  /**
   * True when the instant is inside a scheduled session: of that section, or
   * of any section when no section was given.
   */
  readonly withinScheduledHours: boolean;
}

/** Internal: a session in epoch milliseconds. */
export interface PlacedSession {
  readonly sectionId: string;
  readonly session: Session;
  readonly openMs: number;
  readonly closeMs: number;
}

const CACHE_LIMIT = 20_000;

interface VenueCache {
  readonly cutOverMinutes: number;
  readonly sections: ReadonlyMap<string, Section>;
  readonly exceptions: ReadonlyMap<string, DateException>;
  readonly dayStart: Map<string, number>;
  readonly sessions: Map<string, readonly PlacedSession[]>;
  readonly extra: Map<string, unknown>;
}

const caches = new WeakMap<Venue, VenueCache>();

/** Internal: per-venue lookups and memoised results. The venue is frozen, so they never go stale. */
export function cacheFor(venue: Venue): VenueCache {
  let cache = caches.get(venue);
  if (cache === undefined) {
    cache = {
      cutOverMinutes: clockToMinutes(venue.cutOver),
      sections: new Map(venue.sections.map((section) => [section.id, section])),
      exceptions: new Map(venue.exceptions.map((exception) => [exception.date, exception])),
      dayStart: new Map(),
      sessions: new Map(),
      extra: new Map(),
    };
    caches.set(venue, cache);
  }
  return cache;
}

/** Internal: memoise into a bounded map (cleared when full, which is rare and cheap). */
export function memo<T>(map: Map<string, T>, key: string, compute: () => T): T {
  const hit = map.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  if (map.size >= CACHE_LIMIT) map.clear();
  map.set(key, value);
  return value;
}

function assertSection(venue: Venue, sectionId: string): Section {
  const section = cacheFor(venue).sections.get(sectionId);
  if (section === undefined) {
    throw new RangeError(`Unknown section "${sectionId}" for venue "${venue.id}"`);
  }
  return section;
}

/** Internal: start of trading day `day` in epoch milliseconds. */
export function dayStartMs(venue: Venue, day: TradingDay): number {
  const cache = cacheFor(venue);
  return memo(cache.dayStart, day, () =>
    wallToEpochMs(parseTradingDay(day), cache.cutOverMinutes, venue.timeZone),
  );
}

/** The date exception for a trading day, or `null`. */
export function exceptionFor(venue: Venue, day: TradingDay): DateException | null {
  parseTradingDay(day);
  return cacheFor(venue).exceptions.get(day) ?? null;
}

/**
 * The configured sessions for one section on one trading day, after
 * exceptions (rule 6), as local `HH:MM` pairs.
 */
export function scheduledHours(
  venue: Venue,
  day: TradingDay,
  sectionId: string,
): readonly Session[] {
  const section = assertSection(venue, sectionId);
  const exception = exceptionFor(venue, day);
  if (exception !== null) {
    if (exception.kind === 'closure') {
      if (exception.sectionIds === undefined || exception.sectionIds.includes(sectionId)) return [];
    } else {
      const override = exception.hours?.[sectionId];
      if (override !== undefined) return override;
    }
  }
  return section.hours[weekdayOf(day)] ?? [];
}

/** Internal: sessions of one section on one trading day, in epoch ms, zero-length ones removed. */
export function placedSessions(
  venue: Venue,
  day: TradingDay,
  sectionId: string,
): readonly PlacedSession[] {
  const cache = cacheFor(venue);
  return memo(cache.sessions, `${day}|${sectionId}`, () => {
    const date = parseTradingDay(day);
    const nextDate = date.add({ days: 1 });
    const toMs = (offset: number): number => {
      // Offset is minutes after the cut-over; past midnight means the next date.
      const minutes = cache.cutOverMinutes + offset;
      return minutes >= MINUTES_PER_DAY
        ? wallToEpochMs(nextDate, minutes - MINUTES_PER_DAY, venue.timeZone)
        : wallToEpochMs(date, minutes, venue.timeZone);
    };
    return scheduledHours(venue, day, sectionId)
      .map((session) => {
        const { open, close } = sessionOffsets(session, cache.cutOverMinutes);
        return { sectionId, session, openMs: toMs(open), closeMs: toMs(close) };
      })
      .filter((placed) => placed.closeMs > placed.openMs)
      .sort((a, b) => a.openMs - b.openMs);
  });
}

/** Internal: trading day containing an instant, by the cut-over windows. */
export function tradingDayOfMs(venue: Venue, ms: number): TradingDay {
  const cache = cacheFor(venue);
  const local = zoned(ms, venue.timeZone).toPlainDateTime();
  const minutes = local.hour * 60 + local.minute;
  let day: TradingDay = (
    minutes >= cache.cutOverMinutes
      ? local.toPlainDate()
      : local.toPlainDate().subtract({ days: 1 })
  ).toString();
  // The guess comes from the local clock reading. Near a cut-over that sits in
  // a repeated or skipped hour it can be one day out, so check it against the
  // windows themselves, which are the definition.
  while (ms < dayStartMs(venue, day)) day = addDays(day, -1);
  while (ms >= dayStartMs(venue, addDays(day, 1))) day = addDays(day, 1);
  return day;
}

function sectionIdsFor(venue: Venue, sectionId: string | undefined): readonly string[] {
  if (sectionId === undefined) return venue.sections.map((section) => section.id);
  assertSection(venue, sectionId);
  return [sectionId];
}

/**
 * Which trading day an instant belongs to, and whether it is inside
 * scheduled hours.
 *
 * - With `sectionId`: `withinScheduledHours` is true when that section has a
 *   session containing the instant (`open <= instant < close`).
 * - Without: true when any section does; `sectionId` is `null` in the result.
 *
 * The trading day itself never depends on the section: it is the cut-over
 * window containing the instant (sessions always sit inside that window).
 *
 * @throws RangeError for an invalid instant or an unknown section.
 */
export function tradingDayFor(
  instantUtc: InstantInput,
  venue: Venue,
  sectionId?: string,
): TradingDayAssignment {
  const ms = toEpochMs(instantUtc);
  const ids = sectionIdsFor(venue, sectionId);
  const tradingDay = tradingDayOfMs(venue, ms);
  const withinScheduledHours = ids.some((id) =>
    placedSessions(venue, tradingDay, id).some(
      (placed) => placed.openMs <= ms && ms < placed.closeMs,
    ),
  );
  return { tradingDay, sectionId: sectionId ?? null, withinScheduledHours };
}

/**
 * UTC bounds of a trading day (cut-over to cut-over) and of each scheduled
 * session in it, for one section or all of them.
 *
 * @throws RangeError for an invalid date or an unknown section.
 */
export function tradingDayBounds(
  tradingDay: TradingDay,
  venue: Venue,
  sectionId?: string,
): TradingDayBounds {
  parseTradingDay(tradingDay);
  const ids = sectionIdsFor(venue, sectionId);
  const startMs = dayStartMs(venue, tradingDay);
  const endMs = dayStartMs(venue, addDays(tradingDay, 1));
  const sessions = ids
    .flatMap((id) => placedSessions(venue, tradingDay, id))
    .sort((a, b) => a.openMs - b.openMs || a.sectionId.localeCompare(b.sectionId))
    .map(
      (placed): ScheduledSession => ({
        sectionId: placed.sectionId,
        open: placed.session.open,
        close: placed.session.close,
        openUtc: formatUtc(placed.openMs),
        closeUtc: formatUtc(placed.closeMs),
        durationMinutes: (placed.closeMs - placed.openMs) / 60_000,
      }),
    );
  return {
    tradingDay,
    startUtc: formatUtc(startMs),
    endUtc: formatUtc(endMs),
    durationMinutes: (endMs - startMs) / 60_000,
    exception: exceptionFor(venue, tradingDay),
    sessions,
  };
}
