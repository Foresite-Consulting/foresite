/**
 * @foresite/connectors
 *
 * One folder per vendor (`<vendor>/client.ts`, `sync.ts`, `map.ts`,
 * `fixtures/`, `RUNBOOK.md`), added by the `add-connector` skill. People
 * counters are push-based and live under `counters/` with one adapter per
 * vendor (`counters/milesight/`); import them from `@foresite/connectors/counters`.
 */
export * as counters from './counters';
