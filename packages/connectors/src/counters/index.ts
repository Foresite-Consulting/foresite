/**
 * People counters: vendor-neutral model plus one adapter per vendor.
 * Push-based (devices POST to the ingest endpoint in `apps/web`), so there is
 * no `client.ts`/`sync.ts` pair here: the endpoint replaces them.
 */
import { createHash } from 'node:crypto';
import { milesightAdapter } from './milesight/map';
import type { CounterAdapter } from './types';

export * from './types';
export { parseOffsetTimestamp, toUtcIso } from './timestamps';
export { MILESIGHT_PROVIDER, mapMilesightPayload, milesightAdapter } from './milesight/map';
export { minimiseMilesightPayload } from './milesight/minimise';

const adapters: ReadonlyMap<string, CounterAdapter> = new Map([
  [milesightAdapter.provider, milesightAdapter],
]);

/** The adapter for a provider key from the URL, or `undefined` if unknown. */
export function getCounterAdapter(provider: string): CounterAdapter | undefined {
  return adapters.get(provider);
}

export function counterProviders(): string[] {
  return [...adapters.keys()];
}

/** SHA-256 (hex) of the exact request body. Identifies a raw payload. */
export function hashPayload(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}
