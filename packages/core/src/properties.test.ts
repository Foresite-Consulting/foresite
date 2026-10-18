/**
 * Property-based tests: invariants that must hold for any venue, any time
 * zone and any instant, not just the hand-picked cases.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  bucketEvents,
  intervalFor,
  parseVenue,
  sameWeekdayLastYear,
  fromEpochMs,
  toEpochMs,
  tradingDayBounds,
  tradingDayFor,
  tradingDayIntervals,
  weekdayOf,
  WEEKDAYS,
  type Venue,
} from './index';

const ZONES = [
  'Australia/Perth',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Hobart',
  'Australia/Adelaide',
  'Australia/Darwin',
  'Australia/Brisbane',
  'Australia/Lord_Howe',
  'Pacific/Chatham', // UTC+12:45 / +13:45
  'Asia/Kathmandu', // UTC+5:45
  'America/New_York',
  'Europe/London',
] as const;

const pad = (n: number): string => String(n).padStart(2, '0');
const clock = (minutes: number): string =>
  `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

/** Valid sessions for one day: sorted, non-overlapping offsets after the cut-over. */
const daySessions = (cutOver: number) =>
  fc
    .uniqueArray(fc.integer({ min: 0, max: 1440 }), { minLength: 0, maxLength: 6 })
    .map((points) => {
      const sorted = [...points].sort((a, b) => a - b);
      const sessions: { open: string; close: string }[] = [];
      for (let i = 0; i + 1 < sorted.length; i += 2) {
        const open = sorted[i]!;
        const close = sorted[i + 1]!;
        if (open === 0 && close === 1440) continue; // 24 hours is not allowed
        sessions.push({
          open: clock((cutOver + open) % 1440),
          close: clock((cutOver + close) % 1440),
        });
      }
      return sessions;
    });

const venueArb: fc.Arbitrary<Venue> = fc
  .record({
    zone: fc.constantFrom(...ZONES),
    cutOver: fc.oneof(
      fc.constantFrom(300, 0, 360, 240),
      fc.integer({ min: 0, max: 1439 }), // any minute, including inside a DST change
    ),
  })
  .chain(({ zone, cutOver }) =>
    fc
      .tuple(
        fc.tuple(...WEEKDAYS.map(() => daySessions(cutOver))),
        fc.tuple(...WEEKDAYS.map(() => daySessions(cutOver))),
      )
      .map(([a, b]) =>
        parseVenue({
          id: 'property-venue',
          name: 'Property Test Venue',
          timeZone: zone,
          cutOver: clock(cutOver),
          sections: [
            { id: 'a', name: 'A', hours: Object.fromEntries(WEEKDAYS.map((d, i) => [d, a[i]])) },
            { id: 'b', name: 'B', hours: Object.fromEntries(WEEKDAYS.map((d, i) => [d, b[i]])) },
          ],
        }),
      ),
  );

// 2000 to 2040, millisecond precision.
const instantArb = fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2040, 0, 1) });

// Instants close to Australian DST changes, where bugs live.
const nearTransitionArb = fc
  .record({
    year: fc.integer({ min: 2008, max: 2035 }),
    month: fc.constantFrom(3, 9), // early April, early October (0-based months)
    day: fc.integer({ min: 1, max: 8 }),
    minute: fc.integer({ min: 0, max: 48 * 60 }),
  })
  .map(({ year, month, day, minute }) => Date.UTC(year, month, day) + minute * 60_000);

const anyInstant = fc.oneof(instantArb, nearTransitionArb);
const RUNS = { numRuns: 150 };

// Temporal (polyfill) is slow enough that a few hundred random venues take seconds.
describe('properties', { timeout: 60_000 }, () => {
  it('every instant is in exactly one trading day, and inside its bounds', () => {
    fc.assert(
      fc.property(venueArb, anyInstant, (venue, ms) => {
        const { tradingDay } = tradingDayFor(fromEpochMs(ms), venue);
        const bounds = tradingDayBounds(tradingDay, venue);
        expect(toEpochMs(bounds.startUtc)).toBeLessThanOrEqual(ms);
        expect(ms).toBeLessThan(toEpochMs(bounds.endUtc));
        // Not in the neighbours.
        expect(ms).toBeLessThan(
          toEpochMs(tradingDayBounds(addDays(tradingDay, 1), venue).startUtc),
        );
        expect(ms).toBeGreaterThanOrEqual(
          toEpochMs(tradingDayBounds(addDays(tradingDay, -1), venue).endUtc),
        );
      }),
      RUNS,
    );
  });

  it('bounds are contiguous and 23 to 25 hours long', () => {
    fc.assert(
      fc.property(venueArb, anyInstant, (venue, ms) => {
        const { tradingDay } = tradingDayFor(fromEpochMs(ms), venue);
        const today = tradingDayBounds(tradingDay, venue);
        const tomorrow = tradingDayBounds(addDays(tradingDay, 1), venue);
        expect(today.endUtc).toBe(tomorrow.startUtc);
        expect(today.durationMinutes).toBeGreaterThanOrEqual(23 * 60);
        expect(today.durationMinutes).toBeLessThanOrEqual(25 * 60);
      }),
      RUNS,
    );
  });

  it('sessions sit inside their trading day, in order, without overlap', () => {
    fc.assert(
      fc.property(venueArb, anyInstant, (venue, ms) => {
        const { tradingDay } = tradingDayFor(fromEpochMs(ms), venue);
        const bounds = tradingDayBounds(tradingDay, venue);
        const start = toEpochMs(bounds.startUtc);
        const end = toEpochMs(bounds.endUtc);
        for (const sectionId of ['a', 'b']) {
          let previousClose = start;
          for (const session of tradingDayBounds(tradingDay, venue, sectionId).sessions) {
            const open = toEpochMs(session.openUtc);
            const close = toEpochMs(session.closeUtc);
            expect(open).toBeGreaterThanOrEqual(previousClose);
            expect(close).toBeGreaterThan(open);
            expect(close).toBeLessThanOrEqual(end);
            expect(session.durationMinutes).toBeLessThan(24 * 60 + 60);
            previousClose = close;
            // The open is inside, the close is not.
            expect(tradingDayFor(fromEpochMs(open), venue, sectionId)).toEqual({
              tradingDay,
              sectionId,
              withinScheduledHours: true,
            });
            expect(
              tradingDayFor(fromEpochMs(close - 1), venue, sectionId).withinScheduledHours,
            ).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  it('within-hours for the venue is the OR of its sections', () => {
    fc.assert(
      fc.property(venueArb, anyInstant, (venue, ms) => {
        const all = tradingDayFor(fromEpochMs(ms), venue).withinScheduledHours;
        const any =
          tradingDayFor(fromEpochMs(ms), venue, 'a').withinScheduledHours ||
          tradingDayFor(fromEpochMs(ms), venue, 'b').withinScheduledHours;
        expect(all).toBe(any);
      }),
      RUNS,
    );
  });

  it('intervals tile the trading day and contain their instants', () => {
    fc.assert(
      fc.property(
        venueArb,
        anyInstant,
        fc.constantFrom(15 as const, 60 as const),
        (venue, ms, minutes) => {
          const found = intervalFor(fromEpochMs(ms), venue, minutes);
          expect(toEpochMs(found.startUtc)).toBeLessThanOrEqual(ms);
          expect(ms).toBeLessThan(toEpochMs(found.endUtc));
          const intervals = tradingDayIntervals(found.tradingDay, venue, minutes);
          const bounds = tradingDayBounds(found.tradingDay, venue);
          expect(intervals[0]?.startUtc).toBe(bounds.startUtc);
          expect(intervals.at(-1)?.endUtc).toBe(bounds.endUtc);
          let total = 0;
          intervals.forEach((interval, i) => {
            expect(interval.durationMinutes).toBeGreaterThan(0);
            expect(interval.durationMinutes).toBeLessThanOrEqual(minutes);
            if (i > 0) expect(interval.startUtc).toBe(intervals[i - 1]?.endUtc);
            total += interval.durationMinutes;
          });
          expect(total).toBe(bounds.durationMinutes);
          expect(new Set(intervals.map((i) => i.startUtc)).size).toBe(intervals.length);
        },
      ),
      RUNS,
    );
  });

  it('bucketing preserves counts and totals', () => {
    fc.assert(
      fc.property(
        venueArb,
        fc.array(
          fc.record({
            ms: anyInstant,
            sectionId: fc.constantFrom('a', 'b'),
            cents: fc.integer({ min: -100_000, max: 1_000_000 }),
          }),
          { maxLength: 20 },
        ),
        fc.constantFrom(15 as const, 60 as const),
        (venue, events, minutes) => {
          const buckets = bucketEvents(
            events.map((e) => ({
              at: fromEpochMs(e.ms),
              sectionId: e.sectionId,
              values: { cents: e.cents },
            })),
            venue,
            { intervalMinutes: minutes },
          );
          expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(events.length);
          expect(buckets.reduce((sum, b) => sum + (b.totals.cents ?? 0), 0)).toBe(
            events.reduce((sum, e) => sum + e.cents, 0),
          );
          const keys = buckets.map((b) => `${b.startUtc}|${b.sectionId}`);
          expect(new Set(keys).size).toBe(keys.length);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('same weekday last year keeps the weekday', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('1990-01-01'), max: new Date('2090-01-01'), noInvalidDate: true }),
        (date) => {
          const day = date.toISOString().slice(0, 10);
          expect(weekdayOf(sameWeekdayLastYear(day))).toBe(weekdayOf(day));
        },
      ),
      { numRuns: 300 },
    );
  });
});
