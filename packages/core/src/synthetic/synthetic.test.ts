import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { daysBetween, tradingDayIntervals, weekdayOf } from '../index';
import { runSynthCli, USAGE } from './cli';
import { datasetFiles, toCsv } from './csv';
import { generateSyntheticData, MODELS, SYNTHETIC_NOTICE, type SyntheticDataset } from './generate';
import { SAMPLE_WA_PUBLIC_HOLIDAYS } from './holidays';
import { Rng, cyrb128 } from './prng';
import { SYNTHETIC_SECTION_IDS } from './venue';
import { syntheticWeather } from './weather';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/synthetic/', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'foresite-synth-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function silentIo(cwd = scratch) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { cwd, log: (m: string) => out.push(m), error: (m: string) => err.push(m) },
    out,
    err,
  };
}

// One 120-day run reused by several checks (generation takes a moment).
const season = generateSyntheticData({ days: 120, seed: 7 });

describe('prng', () => {
  it('matches known answers (locks the algorithm: cyrb128 + sfc32)', () => {
    expect(cyrb128('42|test')).toEqual([4093412710, 1342919563, 1521576643, 2793825279]);
    const rng = new Rng(42, 'test');
    expect([rng.nextUint32(), rng.nextUint32(), rng.nextUint32()]).toEqual([
      475712043, 1829938509, 920441739,
    ]);
  });

  it('gives independent streams per key and repeats per seed', () => {
    expect(new Rng(1, 'a').nextUint32()).toBe(new Rng(1, 'a').nextUint32());
    expect(new Rng(1, 'a').nextUint32()).not.toBe(new Rng(1, 'b').nextUint32());
    expect(new Rng(1, 'a').nextUint32()).not.toBe(new Rng(2, 'a').nextUint32());
  });

  it('has sensible distributions', () => {
    const rng = new Rng(3, 'dist');
    const n = 20_000;
    let uniform = 0;
    let normal = 0;
    let normalSq = 0;
    let small = 0;
    let large = 0;
    for (let i = 0; i < n; i += 1) {
      const u = rng.uniform();
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
      uniform += u;
      const z = rng.normal();
      normal += z;
      normalSq += z * z;
      small += rng.poisson(3.5);
      large += rng.poisson(80);
    }
    expect(uniform / n).toBeCloseTo(0.5, 1);
    expect(normal / n).toBeCloseTo(0, 1);
    expect(Math.sqrt(normalSq / n)).toBeCloseTo(1, 1);
    expect(small / n).toBeCloseTo(3.5, 1);
    expect(large / n / 80).toBeCloseTo(1, 1);
    expect(rng.poisson(0)).toBe(0);
    expect(rng.poisson(-1)).toBe(0);
    expect(rng.poisson(Number.NaN)).toBe(0);
    for (let i = 0; i < 100; i += 1) {
      const k = rng.int(2, 4);
      expect([2, 3, 4]).toContain(k);
    }
  });
});

describe('weather', () => {
  it('is seasonal (Southern Hemisphere) and a shorter run is a prefix', () => {
    const year = syntheticWeather(42, '2025-01-01', 365);
    const mean = (month: string, key: 'max_temp_tenths_c' | 'rain_tenths_mm') => {
      const days = year.filter((d) => d.trading_day.slice(5, 7) === month);
      return days.reduce((sum, d) => sum + d[key], 0) / days.length;
    };
    expect(mean('01', 'max_temp_tenths_c')).toBeGreaterThan(mean('07', 'max_temp_tenths_c') + 60);
    expect(mean('07', 'rain_tenths_mm')).toBeGreaterThan(mean('01', 'rain_tenths_mm'));
    expect(syntheticWeather(42, '2025-01-01', 30)).toEqual(year.slice(0, 30));
    for (const day of year) {
      expect(Number.isInteger(day.max_temp_tenths_c)).toBe(true);
      expect(day.rain_tenths_mm).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('generateSyntheticData', { timeout: 30_000 }, () => {
  it('is deterministic: same options, same bytes', () => {
    const a = datasetFiles(generateSyntheticData({ days: 10, seed: 99 }));
    const b = datasetFiles(generateSyntheticData({ days: 10, seed: 99 }));
    expect(a).toEqual(b);
    const c = datasetFiles(generateSyntheticData({ days: 10, seed: 100 }));
    expect(c['intervals.csv']).not.toBe(a['intervals.csv']);
  });

  it('a shorter run is the start of a longer one', () => {
    const short = generateSyntheticData({ days: 7, seed: 7 });
    const days = new Set(short.weather.map((w) => w.trading_day));
    expect(season.intervals.filter((r) => days.has(r.trading_day))).toEqual(short.intervals);
    expect(season.peopleCounts.filter((r) => days.has(r.trading_day))).toEqual(short.peopleCounts);
  });

  it('marks every file as synthetic', () => {
    const files = datasetFiles(generateSyntheticData({ days: 2 }));
    for (const [name, contents] of Object.entries(files)) {
      if (name.endsWith('.csv')) expect(contents.startsWith(`# ${SYNTHETIC_NOTICE}\n`)).toBe(true);
      else expect(JSON.parse(contents)).toMatchObject({ notice: SYNTHETIC_NOTICE });
    }
    expect(SYNTHETIC_NOTICE).toBe('SYNTHETIC DATA - not from any real venue');
  });

  it('uses the fictional venue, sections and default Perth time zone', () => {
    expect(season.venue.name).toBe('Harbourside Test Venue');
    expect(season.venue.timeZone).toBe('Australia/Perth');
    expect(season.venue.sections.map((s) => s.id)).toEqual([...SYNTHETIC_SECTION_IDS]);
    expect(season.options.startDay).toBe('2024-12-20');
  });

  it('keeps money in integer cents, never negative, with GST at 10% of net', () => {
    for (const row of season.intervals) {
      for (const value of Object.values(row)) {
        if (typeof value === 'number') {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }
      expect(row.gst_cents).toBe(Math.floor((row.net_sales_ex_gst_cents + 5) / 10));
      expect(row.gross_sales_inc_gst_cents).toBe(row.net_sales_ex_gst_cents + row.gst_cents);
      expect(row.covers).toBeGreaterThanOrEqual(row.transactions);
      expect(row.labour_minutes_foh % row.scheduled_minutes).toBe(0);
      expect(row.labour_minutes_foh).toBeGreaterThan(0);
    }
  });

  it('only writes rows inside scheduled hours, keyed uniquely', () => {
    const keys = new Set<string>();
    for (const row of season.intervals) {
      expect(row.scheduled_minutes).toBeGreaterThan(0);
      expect(row.scheduled_minutes).toBeLessThanOrEqual(15);
      const key = `${row.interval_start_utc}|${row.section_id}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }
  });

  it('trades harder at the weekend than midweek', () => {
    const byDay = new Map<string, number>();
    for (const row of season.intervals) {
      byDay.set(row.trading_day, (byDay.get(row.trading_day) ?? 0) + row.net_sales_ex_gst_cents);
    }
    const mean = (days: string[]) => {
      const values = [...byDay].filter(([d]) => days.includes(weekdayOf(d))).map(([, v]) => v);
      return values.reduce((a, b) => a + b, 0) / values.length;
    };
    expect(mean(['fri', 'sat'])).toBeGreaterThan(1.8 * mean(['mon', 'tue', 'wed', 'thu']));
  });

  it('follows the calendar: closed Christmas Day, late New Year’s Eve, holiday hours', () => {
    expect(season.intervals.some((r) => r.trading_day === '2024-12-25')).toBe(false);
    expect(season.peopleCounts.some((r) => r.trading_day === '2024-12-25')).toBe(false);
    const nyeBar = season.intervals.filter(
      (r) => r.trading_day === '2024-12-31' && r.section_id === 'bar',
    );
    // 11:00 to 02:00 on a Tuesday (normally 23:00).
    expect(nyeBar).toHaveLength(60);
    // Boxing Day 2024 (a Thursday) trades Sunday hours, functions closed.
    const boxing = season.intervals.filter((r) => r.trading_day === '2024-12-26');
    expect(boxing.filter((r) => r.section_id === 'bar')).toHaveLength(44);
    expect(boxing.some((r) => r.section_id === 'functions')).toBe(false);
  });

  it('balances people in and out at each entry point every day', () => {
    const balance = new Map<string, number>();
    for (const row of season.peopleCounts) {
      const key = `${row.trading_day}|${row.entry_point_id}`;
      balance.set(key, (balance.get(key) ?? 0) + row.people_in - row.people_out);
      expect(row.people_in).toBeGreaterThanOrEqual(0);
      expect(row.people_out).toBeGreaterThanOrEqual(0);
    }
    expect([...balance.values()].every((v) => v === 0)).toBe(true);
    expect(new Set(season.peopleCounts.map((r) => r.section_id))).toEqual(new Set(['', 'deck']));
  });

  it('has no anomalies unless asked', () => {
    expect(season.anomalies).toEqual([]);
  });

  it('adds each anomaly when its flag is on, and lists it', () => {
    const base = generateSyntheticData({ days: 30, seed: 5 });
    const odd = generateSyntheticData({
      days: 30,
      seed: 5,
      anomalies: { closedDay: true, dataGap: true, lateDuplicate: true },
    });
    const kinds = odd.anomalies.map((a) => a.kind);
    expect(kinds).toContain('closed_day');
    expect(kinds).toContain('data_gap');
    expect(kinds).toContain('late_duplicate');

    const closed = odd.anomalies.find((a) => a.kind === 'closed_day');
    expect(odd.intervals.some((r) => r.trading_day === closed?.trading_day)).toBe(false);
    expect(odd.peopleCounts.some((r) => r.trading_day === closed?.trading_day)).toBe(false);
    expect(base.intervals.some((r) => r.trading_day === closed?.trading_day)).toBe(true);

    for (const gap of odd.anomalies.filter((a) => a.kind === 'data_gap')) {
      expect(gap.rows).toBe(8);
      const count = (d: SyntheticDataset) =>
        d.intervals.filter((r) => r.trading_day === gap.trading_day && r.section_id === 'bar')
          .length;
      expect(count(base) - count(odd)).toBe(8);
      expect(
        odd.intervals.some(
          (r) => r.interval_start_utc === gap.interval_start_utc && r.section_id === 'bar',
        ),
      ).toBe(false);
    }

    const duplicates = odd.anomalies.filter((a) => a.kind === 'late_duplicate');
    const tail = odd.intervals.slice(-3 * duplicates.length);
    expect(tail[0]?.interval_start_utc).toBe(duplicates[0]?.interval_start_utc);
    for (const row of tail) {
      expect(
        odd.intervals.filter((r) => r === row || JSON.stringify(r) === JSON.stringify(row)),
      ).toHaveLength(2);
    }
  });

  it('picks anomaly days at random over a long run', () => {
    const long = generateSyntheticData({
      days: 240,
      // A seed where each kind turns up by chance (not only the forced pick).
      seed: 4,
      anomalies: { closedDay: true, dataGap: true, lateDuplicate: true },
    });
    const count = (kind: string) => long.anomalies.filter((a) => a.kind === kind).length;
    expect(count('data_gap')).toBeGreaterThan(1);
    expect(count('late_duplicate')).toBeGreaterThan(1);
    expect(count('closed_day')).toBeGreaterThanOrEqual(1);
    // Never two anomalies of one kind on one day; never a gap on a closed day.
    const closed = new Set(
      long.anomalies.filter((a) => a.kind === 'closed_day').map((a) => a.trading_day),
    );
    for (const anomaly of long.anomalies) {
      if (anomaly.kind !== 'closed_day') expect(closed.has(anomaly.trading_day)).toBe(false);
    }
  });

  it('weather moves the deck most', () => {
    const day = (max: number, rain: number) => ({
      trading_day: '2025-01-15',
      max_temp_tenths_c: max,
      rain_tenths_mm: rain,
    });
    expect(MODELS.deck.weather(day(240, 0))).toBeCloseTo(1);
    expect(MODELS.deck.weather(day(320, 0))).toBeGreaterThan(1.2);
    expect(MODELS.deck.weather(day(400, 0))).toBe(0.75);
    expect(MODELS.deck.weather(day(100, 0))).toBe(0.6);
    expect(MODELS.deck.weather(day(240, 5))).toBeCloseTo(0.7);
    expect(MODELS.deck.weather(day(240, 80))).toBeCloseTo(0.35);
    expect(MODELS.bar.weather(day(240, 5))).toBeCloseTo(1.05);
    expect(MODELS.bar.weather(day(360, 0))).toBeCloseTo(1.1);
    expect(MODELS.restaurant.weather(day(240, 80))).toBeCloseTo(0.9);
    expect(MODELS.functions.weather(day(400, 80))).toBe(1);
  });

  it('handles a venue with daylight saving (Sydney) on both change nights', () => {
    const sydney = generateSyntheticData({
      days: 2,
      startDay: '2025-04-05',
      timeZone: 'Australia/Sydney',
    });
    const spring = generateSyntheticData({
      days: 1,
      startDay: '2025-10-04',
      timeZone: 'Australia/Sydney',
    });
    // The trading days are 25 and 23 hours long.
    expect(tradingDayIntervals('2025-04-05', sydney.venue, 15)).toHaveLength(100);
    expect(tradingDayIntervals('2025-10-04', spring.venue, 15)).toHaveLength(92);
    // Saturday bar 11:00-02:00 is 15 elapsed hours (60 intervals) on both nights.
    const bar = (d: SyntheticDataset, day: string) =>
      d.intervals.filter((r) => r.trading_day === day && r.section_id === 'bar');
    expect(bar(sydney, '2025-04-05')).toHaveLength(60);
    expect(bar(spring, '2025-10-04')).toHaveLength(60);
    expect(bar(spring, '2025-10-04').at(-1)?.local_start).toBe('2025-10-05T01:45+10:00');
    expect(bar(sydney, '2025-04-05').at(-1)?.local_start).toBe('2025-04-06T01:45+11:00');
  });

  it('applies holidays passed in, not just the sample list', () => {
    const custom = generateSyntheticData({
      days: 1,
      startDay: '2025-03-12',
      publicHolidays: [{ date: '2025-03-12', name: 'Made-up Day' }],
    });
    expect(custom.venue.exceptions).toHaveLength(1);
    expect(custom.intervals.some((r) => r.section_id === 'deck')).toBe(true);
    expect(SAMPLE_WA_PUBLIC_HOLIDAYS.length).toBeGreaterThan(20);
  });

  it('rejects bad options', () => {
    expect(() => generateSyntheticData({ days: 0 })).toThrow(ZodError);
    expect(() => generateSyntheticData({ days: 3661 })).toThrow(ZodError);
    expect(() => generateSyntheticData({ days: 1, seed: -1 })).toThrow(ZodError);
    expect(() => generateSyntheticData({ days: 1, startDay: '2025-02-30' })).toThrow(ZodError);
    expect(() => generateSyntheticData({ days: 1, timeZone: '+08:00' })).toThrow(ZodError);
  });

  it('is deterministic for any seed (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const a = generateSyntheticData({ days: 2, seed, startDay: '2025-01-03' });
        const b = generateSyntheticData({ days: 2, seed, startDay: '2025-01-03' });
        expect(datasetFiles(a)).toEqual(datasetFiles(b));
      }),
      { numRuns: 10 },
    );
  });
});

describe('csv', () => {
  it('quotes only when needed', () => {
    const text = toCsv(
      [
        { a: 'plain', b: 1 },
        { a: 'has,comma', b: 2 },
        { a: 'has "quote"', b: 3 },
        { a: 'line\nbreak', b: 4 },
      ],
      ['a', 'b'],
    );
    expect(text).toBe(
      `# ${SYNTHETIC_NOTICE}\na,b\nplain,1\n"has,comma",2\n"has ""quote""",3\n"line\nbreak",4\n`,
    );
  });

  it('guards text cells that a spreadsheet would read as a formula', () => {
    const cells = [
      '=SUM(A1:A9)',
      '+61 8 9000 0000',
      '-1+1',
      '@cmd',
      '\tx',
      '\rx',
      '=a,b',
      "'ok",
      'a=b',
    ];
    const text = toCsv(
      cells.map((a) => ({ a, b: -250 })),
      ['a', 'b'],
    );
    expect(text.split('\n').slice(2, -1)).toEqual([
      "'=SUM(A1:A9),-250",
      "'+61 8 9000 0000,-250",
      "'-1+1,-250",
      "'@cmd,-250",
      "'\tx,-250",
      '"\'\rx",-250',
      '"\'=a,b",-250',
      "'ok,-250",
      'a=b,-250',
    ]);
  });

  it('leaves the generated files untouched (no cell needs the guard)', () => {
    for (const [name, contents] of Object.entries(datasetFiles(season))) {
      if (!name.endsWith('.csv')) continue;
      expect(contents, name).not.toMatch(/(?:^|,)['=+@\t\r-]/m);
    }
  });
});

describe('synth CLI', { timeout: 30_000 }, () => {
  it('regenerates the committed fixture byte for byte', () => {
    const out = join(scratch, 'fixture');
    const { io, err } = silentIo();
    expect(runSynthCli(['--days', '14', '--seed', '42', '--out', out], io)).toBe(0);
    expect(err).toEqual([]);
    const committed = readdirSync(FIXTURE_DIR).sort();
    expect(readdirSync(out).sort()).toEqual(committed);
    for (const name of committed) {
      expect(readFileSync(join(out, name)), name).toEqual(readFileSync(join(FIXTURE_DIR, name)));
    }
  });

  it('keeps the committed fixture small and covering the holiday period', () => {
    const total = readdirSync(FIXTURE_DIR).reduce(
      (sum, name) => sum + readFileSync(join(FIXTURE_DIR, name)).length,
      0,
    );
    expect(total).toBeLessThan(1_000_000);
    const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ seed: 42, days: 14, startDay: '2024-12-20' });
    expect(daysBetween('2024-12-20', '2024-12-25')).toBeLessThan(14);
  });

  it('resolves a relative --out from the given directory and reports what it wrote', () => {
    const { io, out } = silentIo();
    expect(runSynthCli(['--days', '1', '--out', 'rel', '--anomalies'], io)).toBe(0);
    expect(readdirSync(join(scratch, 'rel'))).toContain('intervals.csv');
    expect(out.join('\n')).toMatch(/SYNTHETIC DATA written to .*rel/);
    expect(out.join('\n')).toMatch(/anomalies: closed_day/);
  });

  it('accepts each anomaly flag on its own', () => {
    for (const flag of ['--closed-day', '--data-gap', '--late-duplicate']) {
      const { io, out } = silentIo();
      expect(runSynthCli(['--days', '3', '--out', `flag${flag}`, flag], io)).toBe(0);
      expect(out.join('\n')).toContain(flag.slice(2).replace('-', '_'));
    }
  });

  it('lets unexpected errors (e.g. an unwritable folder) surface', () => {
    const { io } = silentIo();
    expect(runSynthCli(['--days', '1', '--out', join(scratch, 'fixture-file')], io)).toBe(0);
    // A folder under a file cannot be created.
    expect(() =>
      runSynthCli(
        ['--days', '1', '--out', join(scratch, 'fixture-file', 'intervals.csv', 'x')],
        io,
      ),
    ).toThrow(/ENOTDIR|EEXIST/);
  });

  it('prints help', () => {
    const { io, out } = silentIo();
    expect(runSynthCli(['--help'], io)).toBe(0);
    expect(out).toEqual([USAGE]);
  });

  it('fails cleanly on bad input', () => {
    const cases: string[][] = [
      [],
      ['--days', '5'],
      ['--days', 'many', '--out', 'x'],
      ['--days', '5', '--out', 'x', '--seed', '-3'],
      ['--days', '0', '--out', 'x'],
      ['--days', '5', '--out', 'x', '--time-zone', 'Nowhere/Place'],
      ['--days', '5', '--out', 'x', '--bogus'],
      ['stray'],
    ];
    for (const args of cases) {
      const { io, err } = silentIo();
      expect(runSynthCli(args, io), args.join(' ')).toBe(2);
      expect(err.length, args.join(' ')).toBe(1);
    }
  });
});
