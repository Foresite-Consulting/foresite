import { describe, expect, it } from 'vitest';
import { BAR_HOURS, testVenue } from './test-support';
import {
  addDays,
  daysBetween,
  exceptionFor,
  formatUtc,
  isTradingDay,
  parseTradingDay,
  sameDateLastYear,
  sameWeekdayLastYear,
  scheduledHours,
  toEpochMs,
  tradingDayBounds,
  tradingDayFor,
  weekdayOf,
} from './index';

describe('instants', () => {
  it('accepts a Date, epoch milliseconds or an ISO string with an offset', () => {
    const ms = Date.UTC(2026, 9, 17, 12, 0, 0);
    expect(toEpochMs(new Date(ms))).toBe(ms);
    expect(toEpochMs(ms)).toBe(ms);
    expect(toEpochMs('2026-10-17T12:00:00Z')).toBe(ms);
    expect(toEpochMs('2026-10-17T20:00:00+08:00')).toBe(ms);
    expect(toEpochMs('2026-10-17T12:00:00.123456789Z')).toBe(ms + 123);
  });

  it('rejects anything ambiguous or invalid', () => {
    expect(() => toEpochMs(new Date(Number.NaN))).toThrow('Invalid Date');
    expect(() => toEpochMs(Number.NaN)).toThrow(RangeError);
    expect(() => toEpochMs(1.5)).toThrow(RangeError);
    expect(() => toEpochMs(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
    expect(() => toEpochMs('2026-10-17T12:00:00')).toThrow(/use ISO 8601 with Z/);
    expect(() => toEpochMs('2026-10-17')).toThrow(RangeError);
    expect(() => toEpochMs('not a time')).toThrow(RangeError);
    expect(() => toEpochMs({} as unknown as string)).toThrow(/must be a Date/);
  });

  it('formats UTC without needless fractions', () => {
    expect(formatUtc(Date.UTC(2026, 9, 17, 12))).toBe('2026-10-17T12:00:00Z');
    expect(formatUtc(Date.UTC(2026, 9, 17, 12) + 5)).toBe('2026-10-17T12:00:00.005Z');
  });
});

describe('dates', () => {
  it('validates YYYY-MM-DD', () => {
    expect(isTradingDay('2026-10-17')).toBe(true);
    expect(isTradingDay('2024-02-29')).toBe(true);
    expect(isTradingDay('2026-02-29')).toBe(false);
    expect(isTradingDay('2026-10-7')).toBe(false);
    expect(isTradingDay('17/10/2026')).toBe(false);
    expect(isTradingDay(20261017)).toBe(false);
    expect(() => parseTradingDay('2026-13-01')).toThrow(/no such date/);
    expect(() => parseTradingDay('soon')).toThrow(/use YYYY-MM-DD/);
  });

  it('adds days and measures between them', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(() => addDays('2026-10-17', 0.5)).toThrow(RangeError);
    expect(daysBetween('2025-10-18', '2026-10-17')).toBe(364);
    expect(daysBetween('2026-10-17', '2026-10-10')).toBe(-7);
  });

  it('names the weekday', () => {
    expect(weekdayOf('2026-10-19')).toBe('mon');
    expect(weekdayOf('2026-10-17')).toBe('sat');
    expect(weekdayOf('2026-10-18')).toBe('sun');
  });

  it('compares like-for-like: 364 days keeps the weekday', () => {
    for (const day of ['2026-10-17', '2025-01-01', '2024-02-29', '2028-03-01']) {
      expect(weekdayOf(sameWeekdayLastYear(day))).toBe(weekdayOf(day));
      expect(daysBetween(sameWeekdayLastYear(day), day)).toBe(364);
    }
    expect(sameDateLastYear('2026-03-01')).toBe('2025-03-01');
    expect(sameDateLastYear('2024-02-29')).toBe('2023-02-28');
  });
});

describe('tradingDayFor', () => {
  const perth = testVenue();

  it('names the section asked about, or null for the whole venue', () => {
    expect(tradingDayFor('2026-10-17T12:00:00Z', perth, 'bar').sectionId).toBe('bar');
    expect(tradingDayFor('2026-10-17T12:00:00Z', perth).sectionId).toBeNull();
  });

  it('throws for an unknown section', () => {
    expect(() => tradingDayFor('2026-10-17T12:00:00Z', perth, 'rooftop')).toThrow(
      'Unknown section "rooftop" for venue "unit-test-venue"',
    );
  });

  it('closes only the listed sections on a section closure', () => {
    const venue = testVenue({
      exceptions: [
        { kind: 'closure', date: '2026-10-17', name: 'Kitchen refit', sectionIds: ['restaurant'] },
      ],
    });
    // Sat 13:00 AWST.
    expect(tradingDayFor('2026-10-17T05:00:00Z', venue, 'restaurant').withinScheduledHours).toBe(
      false,
    );
    expect(tradingDayFor('2026-10-17T05:00:00Z', venue, 'bar').withinScheduledHours).toBe(true);
  });

  it('works with a midnight cut-over', () => {
    const venue = testVenue({
      cutOver: '00:00',
      sections: [{ id: 'cafe', name: 'Cafe', hours: { sat: [{ open: '07:00', close: '00:00' }] } }],
    });
    // Sat 23:59 and Sun 00:00 AWST.
    expect(tradingDayFor('2026-10-17T15:59:00Z', venue, 'cafe')).toEqual({
      tradingDay: '2026-10-17',
      sectionId: 'cafe',
      withinScheduledHours: true,
    });
    expect(tradingDayFor('2026-10-17T16:00:00Z', venue, 'cafe')).toEqual({
      tradingDay: '2026-10-18',
      sectionId: 'cafe',
      withinScheduledHours: false,
    });
  });

  it('handles a session that opens after midnight', () => {
    const venue = testVenue({
      sections: [{ id: 'club', name: 'Club', hours: { sat: [{ open: '00:30', close: '04:00' }] } }],
    });
    // Sun 01:00 AWST belongs to Saturday's trading day and its late session.
    expect(tradingDayFor('2026-10-17T17:00:00Z', venue, 'club')).toEqual({
      tradingDay: '2026-10-17',
      sectionId: 'club',
      withinScheduledHours: true,
    });
    expect(tradingDayBounds('2026-10-17', venue, 'club').sessions[0]?.openUtc).toBe(
      '2026-10-17T16:30:00Z',
    );
  });

  describe('a cut-over inside a daylight-saving change', () => {
    // Unusual, but legal: a cut-over of 02:30 in Sydney falls in the skipped
    // hour in October and the repeated hour in April.
    const sydney = testVenue({ timeZone: 'Australia/Sydney', cutOver: '02:30' });

    it('skipped: the boundary is the moment the clocks jump', () => {
      const bounds = tradingDayBounds('2026-10-03', sydney);
      // Starts Sat 02:30 AEST; ends at the jump, Sun 02:00 AEST = 03:00 AEDT.
      expect(bounds.startUtc).toBe('2026-10-02T16:30:00Z');
      expect(bounds.endUtc).toBe('2026-10-03T16:00:00Z');
      expect(bounds.durationMinutes).toBe(1410);
      expect(tradingDayFor('2026-10-03T15:59:59.999Z', sydney).tradingDay).toBe('2026-10-03');
      expect(tradingDayFor('2026-10-03T16:00:00Z', sydney).tradingDay).toBe('2026-10-04');
    });

    it('repeated: the boundary is the first 02:30, and the second 02:15 is the new day', () => {
      const bounds = tradingDayBounds('2026-04-04', sydney);
      // Ends at the first 02:30 (AEDT) = 15:30Z.
      expect(bounds.endUtc).toBe('2026-04-04T15:30:00Z');
      expect(bounds.durationMinutes).toBe(1440);
      // 02:15 AEST (the second 02:15) reads earlier than 02:30 on the clock
      // but comes after the boundary.
      expect(tradingDayFor('2026-04-04T16:15:00Z', sydney).tradingDay).toBe('2026-04-05');
      // 02:15 AEDT (the first) is still Saturday.
      expect(tradingDayFor('2026-04-04T15:15:00Z', sydney).tradingDay).toBe('2026-04-04');
      // The new day is 25 hours long.
      expect(tradingDayBounds('2026-04-05', sydney).durationMinutes).toBe(1500);
    });
  });

  it('drops a session that falls wholly in a skipped hour', () => {
    const sydney = testVenue({
      timeZone: 'Australia/Sydney',
      sections: [{ id: 'bar', name: 'Bar', hours: { sat: [{ open: '02:10', close: '02:50' }] } }],
    });
    expect(tradingDayBounds('2026-10-03', sydney, 'bar').sessions).toEqual([]);
    expect(tradingDayBounds('2026-10-10', sydney, 'bar').sessions).toHaveLength(1);
    expect(tradingDayFor('2026-10-03T16:00:00Z', sydney, 'bar').withinScheduledHours).toBe(false);
  });

  it('opens late when the open is in a skipped hour', () => {
    const sydney = testVenue({
      timeZone: 'Australia/Sydney',
      sections: [{ id: 'bar', name: 'Bar', hours: { sat: [{ open: '02:30', close: '04:00' }] } }],
    });
    const [session] = tradingDayBounds('2026-10-03', sydney, 'bar').sessions;
    expect(session?.openUtc).toBe('2026-10-03T16:00:00Z');
    expect(session?.closeUtc).toBe('2026-10-03T17:00:00Z');
    expect(session?.durationMinutes).toBe(60);
  });
});

describe('tradingDayBounds', () => {
  const perth = testVenue();

  it('rejects an invalid date or section', () => {
    expect(() => tradingDayBounds('2026-02-30', perth)).toThrow(RangeError);
    expect(() => tradingDayBounds('2026-10-17', perth, 'rooftop')).toThrow(RangeError);
  });

  it('returns sessions with configured local times and elapsed minutes', () => {
    const bounds = tradingDayBounds('2026-10-16', perth, 'bar');
    expect(bounds.sessions).toEqual([
      {
        sectionId: 'bar',
        open: '11:00',
        close: '02:00',
        openUtc: '2026-10-16T03:00:00Z',
        closeUtc: '2026-10-16T18:00:00Z',
        durationMinutes: 900,
      },
    ]);
    expect(bounds.exception).toBeNull();
  });
});

describe('scheduledHours and exceptionFor', () => {
  const venue = testVenue({
    exceptions: [
      {
        kind: 'public_holiday',
        date: '2026-01-26',
        name: 'Australia Day',
        hours: { bar: [{ open: '11:00', close: '00:00' }] },
      },
      { kind: 'event', date: '2026-11-07', name: 'Live music' },
    ],
  });

  it('uses exception hours for listed sections and weekly hours for the rest', () => {
    expect(scheduledHours(venue, '2026-01-26', 'bar')).toEqual([{ open: '11:00', close: '00:00' }]);
    expect(scheduledHours(venue, '2026-01-26', 'restaurant')).toEqual([]); // Monday: closed
    expect(scheduledHours(venue, '2026-11-07', 'bar')).toEqual(BAR_HOURS.sat);
  });

  it('finds the exception for a date', () => {
    expect(exceptionFor(venue, '2026-01-26')?.name).toBe('Australia Day');
    expect(exceptionFor(venue, '2026-01-27')).toBeNull();
    expect(() => exceptionFor(venue, '26/01/2026')).toThrow(RangeError);
  });

  it('throws for an unknown section', () => {
    expect(() => scheduledHours(venue, '2026-01-26', 'deck')).toThrow(RangeError);
  });
});
