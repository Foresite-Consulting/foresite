/**
 * `npm run synth -w packages/core -- --days 730 --seed 42 --out <dir>`
 *
 * Writes intervals.csv, people_counts.csv, weather.csv, venue.json and
 * manifest.json for Harbourside Test Venue. A relative `--out` is resolved
 * from the directory npm was run in (`INIT_CWD`), not from packages/core.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ZodError } from 'zod';
import { writeDataset } from './write';
import {
  DEFAULT_SYNTHETIC_SEED,
  DEFAULT_SYNTHETIC_START_DAY,
  generateSyntheticData,
} from './generate';

export const USAGE = `Usage: npm run synth -w packages/core -- --days <n> --out <dir> [options]

Generates SYNTHETIC data for the fictional Harbourside Test Venue.

  --days <n>          Trading days to generate (1 to 3660). Required.
  --out <dir>         Output folder (created if missing). Required.
  --seed <n>          PRNG seed, 0 to 4294967295. Default ${DEFAULT_SYNTHETIC_SEED}.
  --start <date>      First trading day, YYYY-MM-DD. Default ${DEFAULT_SYNTHETIC_START_DAY}.
  --time-zone <zone>  IANA time zone. Default Australia/Perth.
  --anomalies         Turn on every anomaly below.
  --closed-day        Add an unplanned closed day.
  --data-gap          Add a two-hour gap in the bar's sales rows.
  --late-duplicate    Add three late duplicate rows.
  --help              Show this help.
`;

export interface CliIo {
  /** Directory relative paths resolve from. */
  readonly cwd: string;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

function integer(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value))
    throw new RangeError(`--${name} must be a whole number, got "${value}"`);
  return Number(value);
}

/** Run the CLI. Returns the process exit code. */
export function runSynthCli(argv: readonly string[], io: CliIo): number {
  try {
    const { values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        days: { type: 'string' },
        out: { type: 'string' },
        seed: { type: 'string' },
        start: { type: 'string' },
        'time-zone': { type: 'string' },
        anomalies: { type: 'boolean', default: false },
        'closed-day': { type: 'boolean', default: false },
        'data-gap': { type: 'boolean', default: false },
        'late-duplicate': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
    if (values.help) {
      io.log(USAGE);
      return 0;
    }
    const days = integer(values.days, 'days');
    if (days === undefined || values.out === undefined) {
      io.error(`--days and --out are required.\n\n${USAGE}`);
      return 2;
    }
    const all = values.anomalies;
    const dataset = generateSyntheticData({
      days,
      seed: integer(values.seed, 'seed'),
      startDay: values.start,
      timeZone: values['time-zone'],
      anomalies: {
        closedDay: all || values['closed-day'],
        dataGap: all || values['data-gap'],
        lateDuplicate: all || values['late-duplicate'],
      },
    });
    const outDir = resolve(io.cwd, values.out);
    const written = writeDataset(dataset, outDir);
    io.log(
      [
        `SYNTHETIC DATA written to ${outDir}`,
        `  ${dataset.options.days} trading days from ${dataset.options.startDay}, seed ${dataset.options.seed}, ${dataset.venue.timeZone}`,
        `  intervals.csv: ${dataset.intervals.length} rows`,
        `  people_counts.csv: ${dataset.peopleCounts.length} rows`,
        `  weather.csv: ${dataset.weather.length} rows`,
        `  anomalies: ${dataset.anomalies.length === 0 ? 'none' : dataset.anomalies.map((a) => `${a.kind} ${a.trading_day}`).join(', ')}`,
        ...written.map((path) => `  wrote ${path}`),
      ].join('\n'),
    );
    return 0;
  } catch (error) {
    if (error instanceof ZodError) {
      io.error(
        `Invalid options:\n${error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n')}`,
      );
      return 2;
    }
    if (error instanceof Error && (error instanceof RangeError || error instanceof TypeError)) {
      io.error(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}
