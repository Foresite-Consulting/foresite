import { describe, expect, it } from 'vitest';
import { testVenueConfig } from '../test-support';
import {
  DEFAULT_CUT_OVER,
  DEFAULT_TIME_ZONE,
  clockToMinutes,
  minutesAfterCutOver,
  parseVenue,
  safeParseVenue,
  sessionOffsets,
  type VenueConfig,
} from './schema';

function issues(config: unknown): string[] {
  const result = safeParseVenue(config);
  if (result.success) return [];
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

function withBarHours(hours: Record<string, { open: string; close: string }[]>): VenueConfig {
  return testVenueConfig({ sections: [{ id: 'bar', name: 'Bar', hours }] });
}

describe('clock helpers', () => {
  it('converts HH:MM to minutes', () => {
    expect(clockToMinutes('00:00')).toBe(0);
    expect(clockToMinutes('05:00')).toBe(300);
    expect(clockToMinutes('23:59')).toBe(1439);
    expect(() => clockToMinutes('24:00')).toThrow(RangeError);
    expect(() => clockToMinutes('5:00')).toThrow(RangeError);
  });

  it('places times after the cut-over, wrapping past midnight', () => {
    expect(minutesAfterCutOver('05:00', 300)).toBe(0);
    expect(minutesAfterCutOver('11:00', 300)).toBe(360);
    expect(minutesAfterCutOver('02:00', 300)).toBe(1260);
    expect(minutesAfterCutOver('04:59', 300)).toBe(1439);
  });

  it('treats a close at the cut-over as the end of the trading day', () => {
    expect(sessionOffsets({ open: '11:00', close: '05:00' }, 300)).toEqual({
      open: 360,
      close: 1440,
    });
    expect(sessionOffsets({ open: '00:00', close: '00:00' }, 0)).toEqual({ open: 0, close: 1440 });
  });
});

describe('parseVenue', () => {
  it('applies the defaults: Perth time zone, 05:00 cut-over, no exceptions', () => {
    const venue = parseVenue(testVenueConfig());
    expect(venue.timeZone).toBe(DEFAULT_TIME_ZONE);
    expect(venue.timeZone).toBe('Australia/Perth');
    expect(venue.cutOver).toBe(DEFAULT_CUT_OVER);
    expect(venue.cutOver).toBe('05:00');
    expect(venue.exceptions).toEqual([]);
  });

  it('defaults a section with no hours to closed every day', () => {
    const venue = parseVenue(
      testVenueConfig({ sections: [{ id: 'functions', name: 'Functions' }] }),
    );
    expect(venue.sections[0]?.hours).toEqual({});
  });

  it('returns a deeply frozen venue', () => {
    const venue = parseVenue(testVenueConfig());
    expect(Object.isFrozen(venue)).toBe(true);
    expect(Object.isFrozen(venue.sections)).toBe(true);
    expect(Object.isFrozen(venue.sections[0]?.hours.mon?.[0])).toBe(true);
  });

  it('canonicalises the time-zone name', () => {
    expect(parseVenue(testVenueConfig({ timeZone: 'australia/sydney' })).timeZone).toBe(
      'Australia/Sydney',
    );
  });

  it('sorts exceptions by date', () => {
    const venue = parseVenue(
      testVenueConfig({
        exceptions: [
          { kind: 'event', date: '2026-12-01', name: 'Later' },
          { kind: 'event', date: '2026-01-01', name: 'Earlier' },
        ],
      }),
    );
    expect(venue.exceptions.map((exception) => exception.date)).toEqual([
      '2026-01-01',
      '2026-12-01',
    ]);
  });

  it('rejects fixed offsets and unknown zones', () => {
    for (const timeZone of ['+08:00', '-05:00', 'Mars/Olympus_Mons', '', 'UTC+8']) {
      expect(issues(testVenueConfig({ timeZone })), timeZone).toEqual([
        'timeZone: Use an IANA time zone such as Australia/Perth or Australia/Sydney',
      ]);
    }
  });

  it('accepts other IANA zones, including UTC', () => {
    for (const timeZone of ['UTC', 'Australia/Lord_Howe', 'Australia/Adelaide', 'Etc/GMT-10']) {
      expect(issues(testVenueConfig({ timeZone })), timeZone).toEqual([]);
    }
  });

  it('rejects malformed fields with plain messages', () => {
    expect(issues(testVenueConfig({ id: 'Has Spaces' }))[0]).toMatch(/^id: Use lower-case/);
    expect(issues(testVenueConfig({ name: '   ' }))).toEqual(['name: Required']);
    expect(issues(testVenueConfig({ cutOver: '5am' }))).toEqual([
      'cutOver: Use 24-hour HH:MM, e.g. 05:00 or 23:30',
    ]);
    expect(issues(testVenueConfig({ sections: [] }))).toEqual([
      'sections: Add at least one section',
    ]);
    expect(issues(withBarHours({ mon: [{ open: '24:00', close: '02:00' }] }))).toEqual([
      'sections.0.hours.mon.0.open: Use 24-hour HH:MM, e.g. 05:00 or 23:30',
    ]);
  });

  it('rejects unknown keys (catches typos such as "satuday")', () => {
    expect(issues(withBarHours({ satuday: [] }))[0]).toMatch(/Unrecognized key/);
    expect(issues({ ...testVenueConfig(), colour: 'blue' })[0]).toMatch(/Unrecognized key/);
  });

  it('rejects duplicate section ids', () => {
    const config = testVenueConfig({
      sections: [
        { id: 'bar', name: 'Bar' },
        { id: 'bar', name: 'Bar again' },
      ],
    });
    expect(issues(config)).toEqual(['sections.1.id: Section id "bar" is used twice']);
  });

  it('allows a close after midnight', () => {
    expect(issues(withBarHours({ sat: [{ open: '11:00', close: '02:00' }] }))).toEqual([]);
    expect(issues(withBarHours({ sat: [{ open: '11:00', close: '05:00' }] }))).toEqual([]);
    expect(issues(withBarHours({ sat: [{ open: '00:30', close: '04:00' }] }))).toEqual([]);
  });

  it('rejects a session with the same open and close', () => {
    expect(issues(withBarHours({ sat: [{ open: '11:00', close: '11:00' }] }))).toEqual([
      'sections.0.hours.sat.0: Session 11:00–11:00 has the same open and close. Sessions must be shorter than 24 hours.',
    ]);
    expect(issues(withBarHours({ sat: [{ open: '05:00', close: '05:00' }] }))).toHaveLength(1);
  });

  it('rejects a session that crosses the cut-over', () => {
    expect(issues(withBarHours({ sat: [{ open: '11:00', close: '06:00' }] }))).toEqual([
      'sections.0.hours.sat.0: Session 11:00–06:00 crosses the trading-day cut-over (05:00). A session must open and close within one trading day; move the cut-over if the venue trades past it.',
    ]);
    expect(issues(withBarHours({ sat: [{ open: '04:00', close: '06:00' }] }))).toHaveLength(1);
    // With a later cut-over the same session is fine.
    expect(
      issues({ ...withBarHours({ sat: [{ open: '11:00', close: '06:00' }] }), cutOver: '07:00' }),
    ).toEqual([]);
  });

  it('rejects overlapping sessions but allows touching ones', () => {
    expect(
      issues(
        withBarHours({
          sat: [
            { open: '17:00', close: '23:00' },
            { open: '12:00', close: '17:30' },
          ],
        }),
      ),
    ).toEqual([
      'sections.0.hours.sat.0: Session 17:00–23:00 overlaps 12:00–17:30. Sessions in a section must not overlap (one may start when another closes).',
    ]);
    expect(
      issues(
        withBarHours({
          sat: [
            { open: '12:00', close: '15:00' },
            { open: '15:00', close: '02:00' },
          ],
        }),
      ),
    ).toEqual([]);
    // Overlap after midnight.
    expect(
      issues(
        withBarHours({
          sat: [
            { open: '20:00', close: '02:00' },
            { open: '01:00', close: '03:00' },
          ],
        }),
      ),
    ).toHaveLength(1);
  });

  it('caps the number of sessions in a day', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      open: `${String(10 + i).padStart(2, '0')}:00`,
      close: `${String(10 + i).padStart(2, '0')}:30`,
    }));
    expect(issues(withBarHours({ sat: many }))[0]).toMatch(/^sections\.0\.hours\.sat:/);
  });

  describe('exceptions', () => {
    it('accepts each kind', () => {
      expect(
        issues(
          testVenueConfig({
            exceptions: [
              { kind: 'closure', date: '2025-12-25', name: 'Christmas Day' },
              { kind: 'closure', date: '2026-02-01', name: 'Deck repairs', sectionIds: ['bar'] },
              { kind: 'public_holiday', date: '2026-01-26', name: 'Australia Day' },
              {
                kind: 'event',
                date: '2026-11-07',
                name: 'Grand final',
                hours: { bar: [{ open: '09:00', close: '02:00' }] },
              },
              {
                kind: 'special_hours',
                date: '2026-12-31',
                name: "New Year's Eve",
                hours: { bar: [{ open: '11:00', close: '04:30' }], restaurant: [] },
              },
            ],
          }),
        ),
      ).toEqual([]);
    });

    it('rejects impossible dates', () => {
      expect(
        issues(testVenueConfig({ exceptions: [{ kind: 'event', date: '2026-02-30', name: 'X' }] })),
      ).toEqual(['exceptions.0.date: Use a real date written YYYY-MM-DD, e.g. 2026-10-17']);
    });

    it('rejects two exceptions on one date', () => {
      expect(
        issues(
          testVenueConfig({
            exceptions: [
              { kind: 'event', date: '2026-11-07', name: 'A' },
              { kind: 'closure', date: '2026-11-07', name: 'B' },
            ],
          }),
        ),
      ).toEqual([
        'exceptions.1.date: More than one exception for 2026-11-07. Combine them into one.',
      ]);
    });

    it('rejects unknown sections', () => {
      expect(
        issues(
          testVenueConfig({
            exceptions: [
              { kind: 'closure', date: '2026-11-07', name: 'A', sectionIds: ['rooftop'] },
              {
                kind: 'public_holiday',
                date: '2026-11-08',
                name: 'B',
                hours: { rooftop: [{ open: '12:00', close: '13:00' }] },
              },
            ],
          }),
        ),
      ).toEqual([
        'exceptions.0.sectionIds.0: Unknown section "rooftop"',
        'exceptions.1.hours.rooftop: Unknown section "rooftop"',
      ]);
    });

    it('validates exception sessions like weekly ones', () => {
      expect(
        issues(
          testVenueConfig({
            exceptions: [
              {
                kind: 'special_hours',
                date: '2026-12-31',
                name: 'NYE',
                hours: { bar: [{ open: '11:00', close: '06:00' }] },
              },
            ],
          }),
        )[0],
      ).toMatch(/^exceptions\.0\.hours\.bar\.0: Session 11:00–06:00 crosses/);
    });

    it('requires hours for special_hours and none for closure', () => {
      expect(
        issues({
          ...testVenueConfig(),
          exceptions: [{ kind: 'special_hours', date: '2026-12-31', name: 'X' }],
        }),
      ).toHaveLength(1);
      expect(
        issues({
          ...testVenueConfig(),
          exceptions: [{ kind: 'closure', date: '2026-12-31', name: 'X', hours: {} }],
        })[0],
      ).toMatch(/Unrecognized key/);
    });

    it('rejects an unknown kind', () => {
      expect(
        issues({
          ...testVenueConfig(),
          exceptions: [{ kind: 'holiday', date: '2026-12-31', name: 'X' }],
        })[0],
      ).toMatch(/^exceptions\.0\.kind: Invalid discriminator/);
    });
  });

  it('reports, never throws, when many fields are wrong at once', () => {
    const config = {
      id: 'x',
      name: 'X',
      timeZone: '+08:00',
      cutOver: 'late',
      sections: [{ id: 'bar', name: 'Bar', hours: { mon: [{ open: 'noon', close: '2am' }] } }],
    };
    expect(() => safeParseVenue(config)).not.toThrow();
    expect(issues(config)).toHaveLength(4);
    expect(issues(null)).toHaveLength(1);
    expect(issues('venue')).toHaveLength(1);
  });

  it('throws a ZodError from parseVenue', () => {
    expect(() => parseVenue({})).toThrow(/Required/);
  });
});
