/**
 * @foresite/core
 *
 * The trading-day and section model every Foresite fact joins on, plus a
 * deterministic synthetic venue data generator for development and tests.
 *
 * - Venue configuration: {@link parseVenue}, {@link venueSchema}.
 * - Trading days: {@link tradingDayFor}, {@link tradingDayBounds}.
 * - Intervals and bucketing: {@link tradingDayIntervals}, {@link intervalFor},
 *   {@link scheduledIntervals}, {@link bucketEvents}.
 * - Comparisons: {@link sameWeekdayLastYear}, {@link sameDateLastYear}.
 * - Synthetic data: {@link generateSyntheticData} (made-up data only).
 *
 * The rules are documented in `docs/data-dictionary.md` and
 * `docs/adr/0002-trading-day-model.md`.
 */
export {
  WEEKDAYS,
  addDays,
  daysBetween,
  isTradingDay,
  parseTradingDay,
  sameDateLastYear,
  sameWeekdayLastYear,
  weekdayOf,
  type TradingDay,
  type Weekday,
} from './time/dates';
export { formatUtc, toEpochMs, type InstantInput } from './time/instant';
export {
  DEFAULT_CUT_OVER,
  DEFAULT_TIME_ZONE,
  dateExceptionSchema,
  parseVenue,
  safeParseVenue,
  sectionSchema,
  sessionSchema,
  venueSchema,
  type DateException,
  type DateExceptionKind,
  type Section,
  type Session,
  type Venue,
  type VenueConfig,
  type WeeklyHours,
} from './venue/schema';
export {
  exceptionFor,
  scheduledHours,
  tradingDayBounds,
  tradingDayFor,
  type ScheduledSession,
  type TradingDayAssignment,
  type TradingDayBounds,
} from './trading-day';
export {
  INTERVAL_MINUTES,
  bucketEvents,
  intervalFor,
  scheduledIntervals,
  tradingDayIntervals,
  type Bucket,
  type BucketEvent,
  type IntervalMinutes,
  type SectionInterval,
  type TradingInterval,
} from './buckets';
