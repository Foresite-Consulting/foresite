/**
 * Runs the golden vectors in `test-vectors/trading-day.json`. The file is the
 * contract: any other implementation (e.g. Python) must pass the same cases.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  parseVenue,
  sameDateLastYear,
  sameWeekdayLastYear,
  tradingDayBounds,
  tradingDayFor,
  tradingDayIntervals,
  type Venue,
} from './index';

const sessionExpect = z.object({
  sectionId: z.string(),
  open: z.string(),
  close: z.string(),
  openUtc: z.string(),
  closeUtc: z.string(),
  durationMinutes: z.number(),
});

const vectorFile = z
  .object({
    description: z.string(),
    schemaVersion: z.literal(1),
    conventions: z.record(z.string()),
    venues: z.record(z.unknown()),
    tradingDayFor: z.array(
      z.object({
        id: z.string(),
        venue: z.string(),
        instant: z.string(),
        sectionId: z.string().nullable(),
        expect: z.object({ tradingDay: z.string(), withinScheduledHours: z.boolean() }),
        why: z.string().min(10),
      }),
    ),
    tradingDayBounds: z.array(
      z.object({
        id: z.string(),
        venue: z.string(),
        tradingDay: z.string(),
        sectionId: z.string().nullable(),
        expect: z.object({
          startUtc: z.string(),
          endUtc: z.string(),
          durationMinutes: z.number(),
          exceptionKind: z.string().optional(),
          sessions: z.array(sessionExpect),
        }),
        why: z.string().min(10),
      }),
    ),
    intervals: z.array(
      z.object({
        id: z.string(),
        venue: z.string(),
        tradingDay: z.string(),
        intervalMinutes: z.union([z.literal(15), z.literal(60)]),
        expect: z.object({
          count: z.number(),
          shortIntervals: z.array(
            z.object({ localStart: z.string(), slot: z.string(), durationMinutes: z.number() }),
          ),
          repeatedSlots: z
            .array(z.object({ slot: z.string(), startUtc: z.array(z.string()) }))
            .optional(),
        }),
        why: z.string().min(10),
      }),
    ),
    comparisons: z.array(
      z.object({
        id: z.string(),
        fn: z.enum(['sameWeekdayLastYear', 'sameDateLastYear']),
        tradingDay: z.string(),
        expect: z.string(),
        why: z.string().min(10),
      }),
    ),
  })
  .strict();

const path = fileURLToPath(new URL('../test-vectors/trading-day.json', import.meta.url));
const vectors = vectorFile.parse(JSON.parse(readFileSync(path, 'utf8')));
const venues = new Map<string, Venue>(
  Object.entries(vectors.venues).map(([key, config]) => [key, parseVenue(config)]),
);

function venue(key: string): Venue {
  const found = venues.get(key);
  if (found === undefined) throw new Error(`Vector names unknown venue "${key}"`);
  return found;
}

describe('golden vectors: file', () => {
  it('has enough hand-checked cases and unique ids', () => {
    const ids = [
      ...vectors.tradingDayFor,
      ...vectors.tradingDayBounds,
      ...vectors.intervals,
      ...vectors.comparisons,
    ].map((vector) => vector.id);
    expect(ids.length).toBeGreaterThanOrEqual(40);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('golden vectors: tradingDayFor', () => {
  it.each(vectors.tradingDayFor)('$id', (vector) => {
    const result = tradingDayFor(
      vector.instant,
      venue(vector.venue),
      vector.sectionId ?? undefined,
    );
    expect(result).toEqual({ ...vector.expect, sectionId: vector.sectionId });
  });
});

describe('golden vectors: tradingDayBounds', () => {
  it.each(vectors.tradingDayBounds)('$id', (vector) => {
    const result = tradingDayBounds(
      vector.tradingDay,
      venue(vector.venue),
      vector.sectionId ?? undefined,
    );
    const { exceptionKind, ...expected } = vector.expect;
    expect({
      startUtc: result.startUtc,
      endUtc: result.endUtc,
      durationMinutes: result.durationMinutes,
      sessions: result.sessions,
    }).toEqual(expected);
    expect(result.exception?.kind).toBe(exceptionKind);
  });
});

describe('golden vectors: intervals', () => {
  it.each(vectors.intervals)('$id', (vector) => {
    const intervals = tradingDayIntervals(
      vector.tradingDay,
      venue(vector.venue),
      vector.intervalMinutes,
    );
    expect(intervals).toHaveLength(vector.expect.count);
    expect(
      intervals
        .filter((interval) => interval.durationMinutes !== vector.intervalMinutes)
        .map(({ localStart, slot, durationMinutes }) => ({ localStart, slot, durationMinutes })),
    ).toEqual(vector.expect.shortIntervals);
    for (const repeated of vector.expect.repeatedSlots ?? []) {
      expect(
        intervals.filter((interval) => interval.slot === repeated.slot).map((i) => i.startUtc),
      ).toEqual(repeated.startUtc);
    }
  });
});

describe('golden vectors: comparisons', () => {
  it.each(vectors.comparisons)('$id', (vector) => {
    const fn = vector.fn === 'sameWeekdayLastYear' ? sameWeekdayLastYear : sameDateLastYear;
    expect(fn(vector.tradingDay)).toBe(vector.expect);
  });
});
