import { describe, expect, it } from 'vitest';
import { testVenue } from './test-support';
import {
  bucketEvents,
  intervalFor,
  scheduledIntervals,
  tradingDayIntervals,
  type IntervalMinutes,
} from './index';

const perth = testVenue();
const sydney = testVenue({ timeZone: 'Australia/Sydney' });

describe('tradingDayIntervals', () => {
  it('tiles a Perth day with aligned 15-minute intervals from the cut-over', () => {
    const intervals = tradingDayIntervals('2026-10-17', perth, 15);
    expect(intervals).toHaveLength(96);
    expect(intervals[0]).toEqual({
      tradingDay: '2026-10-17',
      intervalMinutes: 15,
      startUtc: '2026-10-16T21:00:00Z',
      endUtc: '2026-10-16T21:15:00Z',
      durationMinutes: 15,
      localStart: '2026-10-17T05:00+08:00',
      slot: '05:00',
    });
    expect(intervals.at(-1)?.endUtc).toBe('2026-10-17T21:00:00Z');
    expect(intervals.at(-1)?.slot).toBe('04:45');
  });

  it('cuts the first interval short when the cut-over is not aligned', () => {
    const venue = testVenue({ cutOver: '05:10' });
    const intervals = tradingDayIntervals('2026-10-17', venue, 60);
    expect(intervals[0]?.slot).toBe('05:00');
    expect(intervals[0]?.durationMinutes).toBe(50);
    expect(intervals.at(-1)?.slot).toBe('05:00');
    expect(intervals.at(-1)?.durationMinutes).toBe(10);
    expect(intervals.reduce((sum, i) => sum + i.durationMinutes, 0)).toBe(1440);
  });

  it('gives a repeated hour two intervals and a skipped hour none', () => {
    const back = tradingDayIntervals('2026-04-04', sydney, 15).filter((i) => i.slot === '02:15');
    expect(back.map((i) => i.localStart)).toEqual([
      '2026-04-05T02:15+11:00',
      '2026-04-05T02:15+10:00',
    ]);
    const forward = tradingDayIntervals('2026-10-03', sydney, 60).map((i) => i.slot);
    expect(forward).not.toContain('02:00');
    expect(forward).toContain('01:00');
    expect(forward).toContain('03:00');
  });

  it('rejects interval lengths other than 15 and 60', () => {
    expect(() => tradingDayIntervals('2026-10-17', perth, 30 as IntervalMinutes)).toThrow(
      'intervalMinutes must be 15 or 60, got 30',
    );
  });
});

describe('intervalFor', () => {
  it('finds the interval containing an instant (start inclusive, end exclusive)', () => {
    // Sun 01:30 AWST: Saturday's trading day, the 01:30 slot.
    expect(intervalFor('2026-10-17T17:30:00Z', perth, 15)).toMatchObject({
      tradingDay: '2026-10-17',
      slot: '01:30',
      startUtc: '2026-10-17T17:30:00Z',
    });
    expect(intervalFor('2026-10-17T17:44:59.999Z', perth, 15).slot).toBe('01:30');
    expect(intervalFor('2026-10-17T17:45:00Z', perth, 15).slot).toBe('01:45');
    expect(intervalFor('2026-10-17T17:59:00Z', perth, 60).slot).toBe('01:00');
  });

  it('keeps the two copies of a repeated hour apart', () => {
    const first = intervalFor('2026-04-04T15:30:00Z', sydney, 60);
    const second = intervalFor('2026-04-04T16:30:00Z', sydney, 60);
    expect(first.slot).toBe('02:00');
    expect(second.slot).toBe('02:00');
    expect(first.startUtc).toBe('2026-04-04T15:00:00Z');
    expect(second.startUtc).toBe('2026-04-04T16:00:00Z');
  });

  it('aligns to the local clock in a half-hour zone', () => {
    const adelaide = testVenue({ timeZone: 'Australia/Adelaide' });
    // 12:40Z = 22:10 ACST (UTC+9:30).
    expect(intervalFor('2026-07-15T12:40:00Z', adelaide, 60)).toMatchObject({
      slot: '22:00',
      startUtc: '2026-07-15T12:30:00Z',
      endUtc: '2026-07-15T13:30:00Z',
    });
  });
});

describe('scheduledIntervals', () => {
  it('lists the intervals a section is open, with partial minutes at the edges', () => {
    const venue = testVenue({
      sections: [{ id: 'bar', name: 'Bar', hours: { sat: [{ open: '11:10', close: '12:20' }] } }],
    });
    const intervals = scheduledIntervals('2026-10-17', venue, 'bar', 15);
    expect(intervals.map((i) => [i.slot, i.scheduledMinutes])).toEqual([
      ['11:00', 5],
      ['11:15', 15],
      ['11:30', 15],
      ['11:45', 15],
      ['12:00', 15],
      ['12:15', 5],
    ]);
    expect(intervals.every((i) => i.sectionId === 'bar')).toBe(true);
  });

  it('counts both sessions of a split day', () => {
    const intervals = scheduledIntervals('2026-10-17', perth, 'restaurant', 60);
    expect(intervals.map((i) => i.slot)).toEqual([
      '12:00',
      '13:00',
      '14:00',
      '17:00',
      '18:00',
      '19:00',
      '20:00',
      '21:00',
    ]);
    expect(intervals.reduce((sum, i) => sum + i.scheduledMinutes, 0)).toBe(180 + 270);
  });

  it('is empty on a closed day and throws for an unknown section', () => {
    expect(scheduledIntervals('2026-10-19', perth, 'restaurant', 15)).toEqual([]);
    expect(() => scheduledIntervals('2026-10-19', perth, 'deck', 15)).toThrow(RangeError);
  });

  it('keeps the elapsed length on a night the clocks go back', () => {
    const intervals = scheduledIntervals('2026-04-04', sydney, 'bar', 15);
    expect(intervals.reduce((sum, i) => sum + i.scheduledMinutes, 0)).toBe(900);
  });
});

describe('bucketEvents', () => {
  it('groups by trading day, section and interval and sums the values', () => {
    const buckets = bucketEvents(
      [
        { at: '2026-10-17T12:01:00Z', sectionId: 'bar', values: { cents: 1000, covers: 2 } },
        { at: '2026-10-17T12:14:59Z', sectionId: 'bar', values: { cents: 550 } },
        { at: '2026-10-17T12:05:00Z', sectionId: 'restaurant', values: { cents: 9000 } },
        { at: '2026-10-17T12:15:00Z', sectionId: 'bar', values: { cents: 1 } },
        { at: new Date('2026-10-17T12:16:00Z'), sectionId: 'bar' },
      ],
      perth,
      { intervalMinutes: 15 },
    );
    expect(
      buckets.map((b) => [b.slot, b.sectionId, b.count, b.totals, b.scheduledMinutes]),
    ).toEqual([
      ['20:00', 'bar', 2, { cents: 1550, covers: 2 }, 15],
      ['20:00', 'restaurant', 1, { cents: 9000 }, 15],
      ['20:15', 'bar', 2, { cents: 1 }, 15],
    ]);
  });

  it('puts after-midnight events in the previous trading day', () => {
    const [bucket] = bucketEvents([{ at: '2026-10-17T17:30:00Z', sectionId: 'bar' }], perth, {
      intervalMinutes: 60,
    });
    expect(bucket?.tradingDay).toBe('2026-10-17');
    expect(bucket?.localStart).toBe('2026-10-18T01:00+08:00');
  });

  it('makes two buckets for the repeated hour', () => {
    const buckets = bucketEvents(
      [
        { at: '2026-04-04T15:30:00Z', sectionId: 'bar', values: { n: 1 } },
        { at: '2026-04-04T16:30:00Z', sectionId: 'bar', values: { n: 1 } },
      ],
      sydney,
      { intervalMinutes: 60 },
    );
    expect(buckets.map((b) => [b.slot, b.startUtc])).toEqual([
      ['02:00', '2026-04-04T15:00:00Z'],
      ['02:00', '2026-04-04T16:00:00Z'],
    ]);
    // The bar closed at the first 02:00, so neither copy is scheduled.
    expect(buckets.map((b) => b.scheduledMinutes)).toEqual([0, 0]);
  });

  it('treats a measure called __proto__ as an ordinary key', () => {
    const [bucket] = bucketEvents(
      [{ at: '2026-10-17T12:00:00Z', sectionId: 'bar', values: JSON.parse('{"__proto__": 5}') }],
      perth,
      { intervalMinutes: 15 },
    );
    expect(Object.getPrototypeOf(bucket?.totals)).toBe(Object.prototype);
    expect(Object.entries(bucket?.totals ?? {})).toEqual([['__proto__', 5]]);
  });

  it('rejects unknown sections, bad instants and non-finite values', () => {
    const opts = { intervalMinutes: 15 } as const;
    expect(() =>
      bucketEvents([{ at: '2026-10-17T12:00:00Z', sectionId: 'deck' }], perth, opts),
    ).toThrow(/Unknown section "deck"/);
    expect(() => bucketEvents([{ at: '2026-10-17 12:00', sectionId: 'bar' }], perth, opts)).toThrow(
      RangeError,
    );
    expect(() =>
      bucketEvents(
        [{ at: '2026-10-17T12:00:00Z', sectionId: 'bar', values: { cents: Number.NaN } }],
        perth,
        opts,
      ),
    ).toThrow('Value "cents" must be a finite number, got NaN');
    expect(() => bucketEvents([], perth, { intervalMinutes: 5 as IntervalMinutes })).toThrow(
      RangeError,
    );
  });

  it('returns nothing for no events', () => {
    expect(bucketEvents([], perth, { intervalMinutes: 60 })).toEqual([]);
  });
});
