import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as core from './index';

describe('@foresite/core public API', () => {
  it('exports the model, bucketing and generator (and nothing that touches the file system)', () => {
    expect(Object.keys(core).sort()).toMatchInlineSnapshot(`
      [
        "DEFAULT_CUT_OVER",
        "DEFAULT_SYNTHETIC_SEED",
        "DEFAULT_SYNTHETIC_START_DAY",
        "DEFAULT_TIME_ZONE",
        "INTERVAL_COLUMNS",
        "INTERVAL_MINUTES",
        "PEOPLE_COUNT_COLUMNS",
        "SAMPLE_WA_PUBLIC_HOLIDAYS",
        "SYNTHETIC_ENTRY_POINTS",
        "SYNTHETIC_GENERATOR_VERSION",
        "SYNTHETIC_NOTICE",
        "SYNTHETIC_SECTION_IDS",
        "SYNTHETIC_VENUE_ID",
        "SYNTHETIC_VENUE_NAME",
        "WEATHER_COLUMNS",
        "WEEKDAYS",
        "addDays",
        "bucketEvents",
        "datasetFiles",
        "dateExceptionSchema",
        "daysBetween",
        "exceptionFor",
        "formatUtc",
        "fromEpochMs",
        "generateSyntheticData",
        "intervalFor",
        "isTradingDay",
        "parseTradingDay",
        "parseVenue",
        "safeParseVenue",
        "sameDateLastYear",
        "sameWeekdayLastYear",
        "scheduledHours",
        "scheduledIntervals",
        "sectionSchema",
        "sessionSchema",
        "syntheticOptionsSchema",
        "toCsv",
        "toEpochMs",
        "tradingDayBounds",
        "tradingDayFor",
        "tradingDayIntervals",
        "venueSchema",
        "weekdayOf",
      ]
    `);
  });
});

describe('browser safety', () => {
  it('keeps Node built-ins out of everything the main entry can reach', () => {
    const root = new URL('.', import.meta.url).pathname;
    const nodeOnly = new Set(['synthetic/write.ts', 'synthetic/cli.ts', 'synthetic/cli-entry.ts']);
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !nodeOnly.has(file),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(/from 'node:/);
    }
    // And the main entry never reaches the Node-only files.
    const index = readFileSync(join(root, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/synthetic\/(write|cli)/);
  });
});
