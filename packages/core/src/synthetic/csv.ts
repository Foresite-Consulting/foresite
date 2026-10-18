/**
 * CSV and manifest output for a synthetic dataset.
 *
 * Every CSV starts with the comment line `# SYNTHETIC DATA - not from any
 * real venue`, then a header row. Lines end in `\n`; fields are quoted only
 * when they need it (RFC 4180 style). A text cell starting with `=`, `+`,
 * `-`, `@`, a tab or a carriage return is prefixed with `'` so spreadsheets
 * do not run it as a formula (numbers are never prefixed). Timestamps are ISO 8601 UTC, plus the
 * local start with its offset for reading.
 */
import {
  SYNTHETIC_GENERATOR_VERSION,
  SYNTHETIC_NOTICE,
  type SyntheticDataset,
  type SyntheticIntervalRow,
  type SyntheticPeopleCountRow,
} from './generate';
import type { SyntheticWeatherDay } from './weather';

export const INTERVAL_COLUMNS = [
  'interval_start_utc',
  'interval_end_utc',
  'trading_day',
  'local_start',
  'section_id',
  'scheduled_minutes',
  'covers',
  'transactions',
  'net_sales_ex_gst_cents',
  'gst_cents',
  'gross_sales_inc_gst_cents',
  'labour_minutes_foh',
  'labour_minutes_boh',
  'labour_cost_foh_no_gst_cents',
  'labour_cost_boh_no_gst_cents',
] as const satisfies readonly (keyof SyntheticIntervalRow)[];

export const PEOPLE_COUNT_COLUMNS = [
  'interval_start_utc',
  'interval_end_utc',
  'trading_day',
  'local_start',
  'entry_point_id',
  'section_id',
  'people_in',
  'people_out',
] as const satisfies readonly (keyof SyntheticPeopleCountRow)[];

export const WEATHER_COLUMNS = [
  'trading_day',
  'max_temp_tenths_c',
  'rain_tenths_mm',
] as const satisfies readonly (keyof SyntheticWeatherDay)[];

/** First characters a spreadsheet may read as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

function field(value: string | number): string {
  let text = String(value);
  // Formula-injection guard: a text cell that starts like a formula gets a
  // leading single quote, so Excel, Sheets and Numbers show it as text.
  // Numbers are left alone: a negative amount must stay a number, and a
  // number cannot carry a formula.
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows to CSV text with the synthetic-data notice on the first line. */
export function toCsv<Column extends string>(
  rows: readonly Readonly<Record<Column, string | number>>[],
  columns: readonly Column[],
): string {
  const lines = [`# ${SYNTHETIC_NOTICE}`, columns.join(',')];
  for (const row of rows) lines.push(columns.map((column) => field(row[column])).join(','));
  return `${lines.join('\n')}\n`;
}

/** The manifest: what was generated, from which options, and every anomaly. Deterministic (no timestamps). */
export function manifestFor(dataset: SyntheticDataset): Record<string, unknown> {
  const { options } = dataset;
  return {
    notice: SYNTHETIC_NOTICE,
    generator: '@foresite/core synthetic',
    generatorVersion: SYNTHETIC_GENERATOR_VERSION,
    prng: 'cyrb128 seeding + sfc32, one stream per (kind, trading day, section)',
    venueId: dataset.venue.id,
    venueName: dataset.venue.name,
    timeZone: dataset.venue.timeZone,
    seed: options.seed,
    startDay: options.startDay,
    days: options.days,
    publicHolidays: options.publicHolidays.length,
    anomalyFlags: options.anomalies,
    anomalies: dataset.anomalies,
    files: {
      'intervals.csv': dataset.intervals.length,
      'people_counts.csv': dataset.peopleCounts.length,
      'weather.csv': dataset.weather.length,
      'venue.json': 1,
    },
  };
}

/** File name → contents for a dataset. */
export function datasetFiles(dataset: SyntheticDataset): Record<string, string> {
  return {
    'intervals.csv': toCsv(dataset.intervals, INTERVAL_COLUMNS),
    'people_counts.csv': toCsv(dataset.peopleCounts, PEOPLE_COUNT_COLUMNS),
    'weather.csv': toCsv(dataset.weather, WEATHER_COLUMNS),
    'venue.json': `${JSON.stringify({ notice: SYNTHETIC_NOTICE, ...dataset.venue }, null, 2)}\n`,
    'manifest.json': `${JSON.stringify(manifestFor(dataset), null, 2)}\n`,
  };
}
