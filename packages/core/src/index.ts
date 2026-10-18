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
export { formatUtc, fromEpochMs, toEpochMs, type InstantInput } from './time/instant';
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
export {
  DEFAULT_SYNTHETIC_SEED,
  DEFAULT_SYNTHETIC_START_DAY,
  SYNTHETIC_GENERATOR_VERSION,
  SYNTHETIC_NOTICE,
  generateSyntheticData,
  syntheticOptionsSchema,
  type ResolvedSyntheticOptions,
  type SyntheticAnomaly,
  type SyntheticAnomalyKind,
  type SyntheticDataset,
  type SyntheticIntervalRow,
  type SyntheticOptions,
  type SyntheticPeopleCountRow,
} from './synthetic/generate';
export {
  INTERVAL_COLUMNS,
  PEOPLE_COUNT_COLUMNS,
  WEATHER_COLUMNS,
  datasetFiles,
  toCsv,
} from './synthetic/csv';
export { SAMPLE_WA_PUBLIC_HOLIDAYS, type PublicHoliday } from './synthetic/holidays';
export {
  SYNTHETIC_ENTRY_POINTS,
  SYNTHETIC_SECTION_IDS,
  SYNTHETIC_VENUE_ID,
  SYNTHETIC_VENUE_NAME,
  type SyntheticEntryPoint,
  type SyntheticSectionId,
} from './synthetic/venue';
export { type SyntheticWeatherDay } from './synthetic/weather';
