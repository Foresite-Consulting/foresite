/**
 * Synthetic venue data: made-up but realistic numbers for Harbourside Test
 * Venue, for development, demos and tests. **Never** real client data.
 *
 * Per section and 15-minute interval: covers, transactions, net sales ex
 * GST, GST, labour minutes and cost (front and back of house). Per entry
 * point and interval: people in and out. Per trading day: weather.
 *
 * ## Model (all numbers invented)
 *
 * Expected transactions in an interval =
 * `peak rate × intraday curve × weekday × season × trend × holiday ×
 *  weather × day noise × scheduled minutes / 60`, then a Poisson draw.
 *
 * - **Intraday curve:** sums of Gaussian bumps per section (bar lunch,
 *   after-work and late peaks, with a later peak on Friday and Saturday;
 *   restaurant lunch and dinner; deck afternoon; functions evening).
 * - **Weekday:** Friday and Saturday highest, Monday lowest.
 * - **Season:** Southern Hemisphere summer peak (late January, ±15%), plus a
 *   December party-season lift.
 * - **Trend:** +5% a year.
 * - **Public holidays:** +25% bar and deck, +10% restaurant.
 * - **Weather:** the deck drops on wet days and rises on warm ones; the bar
 *   gains a little when it rains (people move inside).
 * - **Noise:** a per-day, per-section factor `exp(N(0, 0.08))`, the Poisson
 *   draw, and per-interval spend noise.
 * - **Money:** integer cents. Net sales = transactions × average spend ×
 *   `exp(N(0, 0.35/√n))`, rounded. GST = net ÷ 10, rounded half up, on the
 *   interval total. Gross = net + GST.
 * - **Labour:** rostered from the *planned* rate (no weather or noise), so
 *   labour % moves with trade the way it does in a real venue. Minutes =
 *   staff × scheduled minutes. Cost = minutes × hourly rate × day loading
 *   (Sat 125%, Sun 150%, public holiday 225%), rounded. The rates and
 *   loadings are invented and are not award advice. Wages have no GST.
 * - **People counts:** arrivals are a share of the covers of the sections
 *   behind each entry point (Poisson); each 15 minutes 20% of the people
 *   inside leave; everyone has left by the last open interval of the day.
 *
 * ## Anomalies (off by default)
 *
 * - `closedDay`: an unplanned closure (no sales or counts at all).
 * - `dataGap`: two hours of a section's sales rows missing.
 * - `lateDuplicate`: three rows repeated at the end of the file, out of order.
 *
 * Each picks days at random (about one every 180, 90 and 90 days); when a run
 * has none, one is placed at a fixed point of the run so tests always see it.
 * Every anomaly is listed in the manifest.
 */
import { z } from 'zod';
import { scheduledIntervals, tradingDayIntervals, type SectionInterval } from '../buckets';
import { addDays, isTradingDay, weekdayOf, type TradingDay, type Weekday } from '../time/dates';
import { exceptionFor } from '../trading-day';
import { DEFAULT_TIME_ZONE, parseVenue, type Venue } from '../venue/schema';
import { SAMPLE_WA_PUBLIC_HOLIDAYS } from './holidays';
import { Rng } from './prng';
import {
  SYNTHETIC_ENTRY_POINTS,
  SYNTHETIC_SECTION_IDS,
  syntheticVenueConfig,
  type SyntheticSectionId,
} from './venue';
import { syntheticWeather, yearFraction, type SyntheticWeatherDay } from './weather';

/** Version of the generator's model. Bump when output changes for the same options. */
export const SYNTHETIC_GENERATOR_VERSION = 1;
export const SYNTHETIC_NOTICE = 'SYNTHETIC DATA - not from any real venue';
export const DEFAULT_SYNTHETIC_START_DAY = '2024-12-20';
export const DEFAULT_SYNTHETIC_SEED = 42;

export const syntheticOptionsSchema = z
  .object({
    /** PRNG seed, an unsigned 32-bit integer. */
    seed: z.number().int().min(0).max(0xffffffff).default(DEFAULT_SYNTHETIC_SEED),
    /** First trading day. */
    startDay: z
      .string()
      .refine(isTradingDay, 'Use a real date written YYYY-MM-DD')
      .default(DEFAULT_SYNTHETIC_START_DAY),
    /** Number of trading days, 1 to 3660 (about ten years). */
    days: z.number().int().min(1).max(3660),
    /** IANA time zone for the venue (checked by the venue schema). */
    timeZone: z.string().default(DEFAULT_TIME_ZONE),
    /** Public holidays to apply. Default: the sample WA list. */
    publicHolidays: z
      .array(
        z
          .object({
            date: z.string().refine(isTradingDay, 'Use YYYY-MM-DD'),
            name: z.string().min(1).max(100),
          })
          .strict(),
      )
      .max(1000)
      .default([...SAMPLE_WA_PUBLIC_HOLIDAYS]),
    anomalies: z
      .object({
        closedDay: z.boolean().default(false),
        dataGap: z.boolean().default(false),
        lateDuplicate: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict();

export type SyntheticOptions = z.input<typeof syntheticOptionsSchema>;
export type ResolvedSyntheticOptions = z.output<typeof syntheticOptionsSchema>;

/** One section × 15-minute interval. Money in integer cents; GST basis in each name. */
export interface SyntheticIntervalRow {
  readonly interval_start_utc: string;
  readonly interval_end_utc: string;
  readonly trading_day: TradingDay;
  readonly local_start: string;
  readonly section_id: SyntheticSectionId;
  readonly scheduled_minutes: number;
  readonly covers: number;
  readonly transactions: number;
  readonly net_sales_ex_gst_cents: number;
  readonly gst_cents: number;
  readonly gross_sales_inc_gst_cents: number;
  readonly labour_minutes_foh: number;
  readonly labour_minutes_boh: number;
  readonly labour_cost_foh_no_gst_cents: number;
  readonly labour_cost_boh_no_gst_cents: number;
}

/** One entry point × 15-minute interval. `section_id` is empty for a venue-wide entrance. */
export interface SyntheticPeopleCountRow {
  readonly interval_start_utc: string;
  readonly interval_end_utc: string;
  readonly trading_day: TradingDay;
  readonly local_start: string;
  readonly entry_point_id: string;
  readonly section_id: string;
  readonly people_in: number;
  readonly people_out: number;
}

export type SyntheticAnomalyKind = 'closed_day' | 'data_gap' | 'late_duplicate';

export interface SyntheticAnomaly {
  readonly kind: SyntheticAnomalyKind;
  readonly trading_day: TradingDay;
  readonly section_id: string | null;
  /** First affected interval, for gaps and duplicates. */
  readonly interval_start_utc: string | null;
  readonly rows: number;
  readonly note: string;
}

export interface SyntheticDataset {
  readonly options: ResolvedSyntheticOptions;
  readonly venue: Venue;
  /** Ordered by trading day, section, interval; late duplicates last. */
  readonly intervals: readonly SyntheticIntervalRow[];
  readonly peopleCounts: readonly SyntheticPeopleCountRow[];
  readonly weather: readonly SyntheticWeatherDay[];
  readonly anomalies: readonly SyntheticAnomaly[];
}

export interface SectionModel {
  /** Transactions an hour at the top of the curve on a 1.0 day. */
  readonly peakPerHour: number;
  /** Average spend per transaction, cents ex GST. */
  readonly averageSpendCents: number;
  /** Covers per transaction. */
  readonly coversPerTransaction: number;
  readonly weekday: Readonly<Record<Weekday, number>>;
  readonly holiday: number;
  readonly minFoh: number;
  /** Transactions one FOH staff member handles in 15 minutes. */
  readonly transactionsPerFoh: number;
  readonly minBoh: number;
  /** Covers one BOH staff member handles in 15 minutes (0: no BOH). */
  readonly coversPerBoh: number;
  readonly curve: (hour: number, weekday: Weekday) => number;
  readonly weather: (weather: SyntheticWeatherDay) => number;
}

const bump = (hour: number, centre: number, width: number): number =>
  Math.exp(-0.5 * ((hour - centre) / width) ** 2);

const LATE_NIGHTS: readonly Weekday[] = ['fri', 'sat'];

/** Internal: the per-section model (exported for tests only, not from the package). */
export const MODELS: Readonly<Record<SyntheticSectionId, SectionModel>> = {
  bar: {
    peakPerHour: 70,
    averageSpendCents: 1850,
    coversPerTransaction: 1.4,
    weekday: { mon: 0.55, tue: 0.6, wed: 0.7, thu: 0.85, fri: 1.3, sat: 1.45, sun: 0.95 },
    holiday: 1.25,
    minFoh: 3,
    transactionsPerFoh: 3.5,
    minBoh: 0,
    coversPerBoh: 0,
    curve: (h, weekday) =>
      0.12 +
      0.35 * bump(h, 13, 1.2) +
      0.8 * bump(h, 18, 1.5) +
      0.5 * bump(h, 21, 1.8) +
      (LATE_NIGHTS.includes(weekday) ? 0.6 * bump(h, 23.5, 1.4) : 0),
    weather: (w) => (w.rain_tenths_mm > 0 ? 1.05 : 1) * (w.max_temp_tenths_c > 350 ? 1.1 : 1),
  },
  restaurant: {
    peakPerHour: 14,
    averageSpendCents: 9500,
    coversPerTransaction: 2.6,
    weekday: { mon: 0, tue: 0.6, wed: 0.7, thu: 0.85, fri: 1.2, sat: 1.35, sun: 1 },
    holiday: 1.1,
    minFoh: 3,
    transactionsPerFoh: 1,
    minBoh: 3,
    coversPerBoh: 6,
    curve: (h) => 0.1 + 1.0 * bump(h, 12.9, 0.8) + 1.0 * bump(h, 19.2, 1.0),
    weather: (w) => (w.rain_tenths_mm > 50 ? 0.9 : 1),
  },
  deck: {
    peakPerHour: 35,
    averageSpendCents: 2600,
    coversPerTransaction: 1.6,
    weekday: { mon: 0.5, tue: 0.5, wed: 0.6, thu: 0.7, fri: 1.1, sat: 1.4, sun: 1.3 },
    holiday: 1.25,
    minFoh: 2,
    transactionsPerFoh: 3.5,
    minBoh: 0,
    coversPerBoh: 0,
    curve: (h) => 0.1 + 0.7 * bump(h, 15.5, 2) + 0.6 * bump(h, 18.5, 1.5),
    weather: (w) => {
      const temp = w.max_temp_tenths_c / 10;
      const warmth = temp > 38 ? 0.75 : Math.min(1.4, Math.max(0.6, 1 + 0.03 * (temp - 24)));
      const rain = w.rain_tenths_mm > 20 ? 0.35 : w.rain_tenths_mm > 0 ? 0.7 : 1;
      return warmth * rain;
    },
  },
  functions: {
    peakPerHour: 3,
    averageSpendCents: 42000,
    coversPerTransaction: 8,
    weekday: { mon: 0, tue: 0, wed: 0, thu: 0, fri: 1, sat: 1.2, sun: 0 },
    holiday: 1,
    minFoh: 4,
    transactionsPerFoh: 0.3,
    minBoh: 3,
    coversPerBoh: 12,
    curve: (h) => 0.2 + 0.8 * bump(h, 20, 1.5),
    weather: () => 1,
  },
};

/** Invented hourly rates including on-costs, cents (no GST on wages). */
const FOH_RATE_CENTS = 3900;
const BOH_RATE_CENTS = 4300;

const TAU = 2 * Math.PI;

function seasonFactor(day: TradingDay): number {
  const t = yearFraction(day);
  const month = Number(day.slice(5, 7));
  const dayOfMonth = Number(day.slice(8, 10));
  const partySeason = month === 12 && dayOfMonth <= 23 ? 1.15 : 1;
  return (1 + 0.15 * Math.cos(TAU * (t - 25 / 365))) * partySeason;
}

/** Hours since local midnight of the trading day's date (after midnight counts on: 25 = 1 am). */
function tradingHour(interval: SectionInterval): number {
  const [hh, mm] = interval.slot.split(':').map(Number) as [number, number];
  const nextDate = interval.localStart.slice(0, 10) !== interval.tradingDay;
  return hh + mm / 60 + (nextDate ? 24 : 0);
}

function loadingPercent(weekday: Weekday, holiday: boolean): number {
  if (holiday) return 225;
  if (weekday === 'sat') return 125;
  if (weekday === 'sun') return 150;
  return 100;
}

function pickDays(
  seed: number,
  kind: SyntheticAnomalyKind,
  days: readonly TradingDay[],
  rate: number,
  forcedIndex: number,
  eligible: (day: TradingDay) => boolean,
): Set<TradingDay> {
  const picked = new Set(
    days.filter((day) => eligible(day) && new Rng(seed, 'anomaly', kind, day).chance(rate)),
  );
  if (picked.size === 0) {
    // Nothing by chance: use the first eligible day from a fixed point.
    for (let i = 0; i < days.length; i += 1) {
      const day = days[(forcedIndex + i) % days.length];
      if (day !== undefined && eligible(day)) {
        picked.add(day);
        break;
      }
    }
  }
  return picked;
}

/**
 * Generate a synthetic dataset. Same options, same output, byte for byte.
 *
 * @throws ZodError for invalid options (including the time zone).
 */
export function generateSyntheticData(input: SyntheticOptions): SyntheticDataset {
  const options = syntheticOptionsSchema.parse(input);
  const { seed, startDay, days: dayCount, anomalies: flags } = options;
  const lastDay = addDays(startDay, dayCount - 1);
  const venue = parseVenue(
    syntheticVenueConfig({
      timeZone: options.timeZone,
      publicHolidays: options.publicHolidays,
      firstDay: startDay,
      lastDay,
    }),
  );
  const days = Array.from({ length: dayCount }, (_, i) => addDays(startDay, i));
  const weather = syntheticWeather(seed, startDay, dayCount);
  const holidays = new Set(options.publicHolidays.map((holiday) => holiday.date));

  const openSections = (day: TradingDay): SyntheticSectionId[] =>
    SYNTHETIC_SECTION_IDS.filter((id) => scheduledIntervals(day, venue, id, 15).length > 0);

  const closedDays = flags.closedDay
    ? pickDays(
        seed,
        'closed_day',
        days,
        1 / 180,
        Math.floor(dayCount / 2),
        (d) => openSections(d).length > 0,
      )
    : new Set<TradingDay>();
  const tradingOn = (d: TradingDay): boolean =>
    !closedDays.has(d) && openSections(d).includes('bar');
  const gapDays = flags.dataGap
    ? pickDays(seed, 'data_gap', days, 1 / 90, Math.floor(dayCount / 3), tradingOn)
    : new Set<TradingDay>();
  const duplicateDays = flags.lateDuplicate
    ? pickDays(seed, 'late_duplicate', days, 1 / 90, Math.floor((2 * dayCount) / 3), tradingOn)
    : new Set<TradingDay>();

  const intervalRows: SyntheticIntervalRow[] = [];
  const duplicates: SyntheticIntervalRow[] = [];
  const peopleCounts: SyntheticPeopleCountRow[] = [];
  const anomalies: SyntheticAnomaly[] = [];

  weather.forEach((dayWeather, dayIndex) => {
    const day = dayWeather.trading_day;
    const weekday = weekdayOf(day);
    if (closedDays.has(day)) {
      anomalies.push({
        kind: 'closed_day',
        trading_day: day,
        section_id: null,
        interval_start_utc: null,
        rows: 0,
        note: 'Unplanned closure: no sales or people counts recorded.',
      });
      return;
    }
    const exception = exceptionFor(venue, day);
    const holiday = holidays.has(day) && exception?.kind !== 'closure';
    const season = seasonFactor(day);
    const trend = 1 + (0.05 * dayIndex) / 365;
    const coversByInterval = new Map<string, Map<SyntheticSectionId, number>>();

    for (const sectionId of SYNTHETIC_SECTION_IDS) {
      const intervals = scheduledIntervals(day, venue, sectionId, 15);
      if (intervals.length === 0) continue;
      const model = MODELS[sectionId];
      const rng = new Rng(seed, 'sales', day, sectionId);
      const dayNoise = Math.exp(rng.normal(0, 0.08));
      const base =
        model.peakPerHour * model.weekday[weekday] * season * trend * (holiday ? model.holiday : 1);
      const sectionRows: SyntheticIntervalRow[] = [];
      for (const interval of intervals) {
        const hourShare = interval.scheduledMinutes / 60;
        const plannedRate = base * model.curve(tradingHour(interval), weekday);
        const transactions = rng.poisson(
          plannedRate * model.weather(dayWeather) * dayNoise * hourShare,
        );
        const covers =
          transactions === 0
            ? 0
            : Math.max(
                transactions,
                Math.round(
                  transactions * model.coversPerTransaction * Math.exp(rng.normal(0, 0.1)),
                ),
              );
        const net =
          transactions === 0
            ? 0
            : Math.round(
                transactions *
                  model.averageSpendCents *
                  Math.exp(rng.normal(0, 0.35 / Math.sqrt(transactions))),
              );
        const gst = Math.floor((net + 5) / 10);
        // Roster: planned transactions in a full 15 minutes.
        const plannedPer15 = plannedRate / 4;
        const foh = Math.max(model.minFoh, Math.ceil(plannedPer15 / model.transactionsPerFoh));
        const boh =
          model.coversPerBoh === 0
            ? 0
            : Math.max(
                model.minBoh,
                Math.ceil((plannedPer15 * model.coversPerTransaction) / model.coversPerBoh),
              );
        const minutes = interval.scheduledMinutes;
        const loading = loadingPercent(weekday, holiday);
        const fohMinutes = Math.round(foh * minutes);
        const bohMinutes = Math.round(boh * minutes);
        sectionRows.push({
          interval_start_utc: interval.startUtc,
          interval_end_utc: interval.endUtc,
          trading_day: day,
          local_start: interval.localStart,
          section_id: sectionId,
          scheduled_minutes: minutes,
          covers,
          transactions,
          net_sales_ex_gst_cents: net,
          gst_cents: gst,
          gross_sales_inc_gst_cents: net + gst,
          labour_minutes_foh: fohMinutes,
          labour_minutes_boh: bohMinutes,
          labour_cost_foh_no_gst_cents: Math.round((fohMinutes * FOH_RATE_CENTS * loading) / 6000),
          labour_cost_boh_no_gst_cents: Math.round((bohMinutes * BOH_RATE_CENTS * loading) / 6000),
        });
        let byInterval = coversByInterval.get(interval.startUtc);
        if (byInterval === undefined) {
          byInterval = new Map();
          coversByInterval.set(interval.startUtc, byInterval);
        }
        byInterval.set(sectionId, covers);
      }

      let kept = sectionRows;
      if (sectionId === 'bar' && gapDays.has(day)) {
        const from = Math.floor(sectionRows.length * 0.4);
        const removed = sectionRows.slice(from, from + 8);
        kept = [...sectionRows.slice(0, from), ...sectionRows.slice(from + 8)];
        anomalies.push({
          kind: 'data_gap',
          trading_day: day,
          section_id: sectionId,
          interval_start_utc: removed[0]?.interval_start_utc ?? null,
          rows: removed.length,
          note: 'Sales feed gap: these intervals are missing from intervals.csv.',
        });
      }
      if (sectionId === 'bar' && duplicateDays.has(day)) {
        const dupRng = new Rng(seed, 'duplicate', day);
        const from = dupRng.int(0, Math.max(0, kept.length - 3));
        const copies = kept.slice(from, from + 3);
        duplicates.push(...copies);
        anomalies.push({
          kind: 'late_duplicate',
          trading_day: day,
          section_id: sectionId,
          interval_start_utc: copies[0]?.interval_start_utc ?? null,
          rows: copies.length,
          note: 'These rows appear twice: again at the end of intervals.csv, as a late resend.',
        });
      }
      intervalRows.push(...kept);
    }

    // People counters run on their own, so a sales gap does not affect them.
    const allIntervals = tradingDayIntervals(day, venue, 15);
    for (const entry of SYNTHETIC_ENTRY_POINTS) {
      const open = allIntervals.filter((interval) => {
        const covers = coversByInterval.get(interval.startUtc);
        return (
          covers !== undefined &&
          Object.keys(entry.feeds).some((id) => covers.has(id as SyntheticSectionId))
        );
      });
      const rng = new Rng(seed, 'people', day, entry.id);
      let inside = 0;
      open.forEach((interval, index) => {
        const covers = coversByInterval.get(interval.startUtc);
        let expected = 0;
        for (const [id, share] of Object.entries(entry.feeds)) {
          expected += (covers?.get(id as SyntheticSectionId) ?? 0) * share;
        }
        const peopleIn = rng.poisson(expected);
        const last = index === open.length - 1;
        const peopleOut = last ? inside + peopleIn : Math.min(inside, rng.poisson(inside * 0.2));
        inside += peopleIn - peopleOut;
        peopleCounts.push({
          interval_start_utc: interval.startUtc,
          interval_end_utc: interval.endUtc,
          trading_day: day,
          local_start: interval.localStart,
          entry_point_id: entry.id,
          section_id: entry.sectionId ?? '',
          people_in: peopleIn,
          people_out: peopleOut,
        });
      });
    }
  });

  return {
    options,
    venue,
    intervals: [...intervalRows, ...duplicates],
    peopleCounts,
    weather,
    anomalies,
  };
}
