/**
 * Writing a dataset to disk (Node only). Kept apart from `csv.ts` so the
 * package's main entry never imports `node:fs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { datasetFiles } from './csv';
import type { SyntheticDataset } from './generate';

/** Write a dataset's files into `outDir` (created if missing). Returns the paths written. */
export function writeDataset(dataset: SyntheticDataset, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  return Object.entries(datasetFiles(dataset)).map(([name, contents]) => {
    const path = join(outDir, name);
    writeFileSync(path, contents, 'utf8');
    return path;
  });
}
