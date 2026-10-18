/**
 * Writing a dataset to disk (Node only). Kept apart from `csv.ts` so the
 * package's main entry never imports `node:fs`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { datasetFiles, manifestFor } from './csv';
import type { SyntheticDataset } from './generate';

/** Manifest fields that identify a dataset. A folder holding another dataset is not overwritten. */
export const IDENTITY_FIELDS = ['seed', 'days', 'startDay', 'timeZone', 'anomalyFlags'] as const;

/** Thrown when `outDir` already holds a different dataset and `force` was not given. */
export class DatasetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetConflictError';
  }
}

function identity(manifest: unknown): string {
  const record = (typeof manifest === 'object' && manifest !== null ? manifest : {}) as Record<
    string,
    unknown
  >;
  return JSON.stringify(IDENTITY_FIELDS.map((field) => record[field] ?? null));
}

function summary(manifest: unknown): string {
  const record = (typeof manifest === 'object' && manifest !== null ? manifest : {}) as Record<
    string,
    unknown
  >;
  return IDENTITY_FIELDS.map((field) => `${field} ${JSON.stringify(record[field] ?? null)}`).join(
    ', ',
  );
}

/**
 * Write a dataset's files into `outDir` (created if missing). Returns the paths written.
 *
 * Refuses (throws {@link DatasetConflictError}) when `outDir` already has a
 * `manifest.json` for a different dataset (seed, days, start day, time zone
 * or anomaly flags), unless `force` is set. Rewriting the same dataset is
 * allowed: it gives the same bytes.
 */
export function writeDataset(
  dataset: SyntheticDataset,
  outDir: string,
  options: { force?: boolean } = {},
): string[] {
  const manifestPath = join(outDir, 'manifest.json');
  if (options.force !== true && existsSync(manifestPath)) {
    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      existing = null;
    }
    const wanted = manifestFor(dataset);
    if (identity(existing) !== identity(wanted)) {
      throw new DatasetConflictError(
        `${outDir} already holds a different synthetic dataset (${existing === null ? 'unreadable manifest.json' : summary(existing)}). Choose another --out, or pass --force to overwrite it.`,
      );
    }
  }
  mkdirSync(outDir, { recursive: true });
  return Object.entries(datasetFiles(dataset)).map(([name, contents]) => {
    const path = join(outDir, name);
    writeFileSync(path, contents, 'utf8');
    return path;
  });
}
