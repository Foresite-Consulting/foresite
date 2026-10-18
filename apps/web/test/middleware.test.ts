import { describe, expect, it } from 'vitest';
import { config } from '../middleware';

/**
 * The matcher is a path-to-regexp source; for these paths it behaves as a
 * plain regular expression anchored at both ends.
 */
const source = config.matcher[0]?.source ?? '';
const matches = (path: string) => new RegExp(`^${source}$`).test(path);

describe('middleware matcher', () => {
  it('runs on pages and the health route', () => {
    expect(matches('/')).toBe(true);
    expect(matches('/offline')).toBe(true);
    expect(matches('/api/health')).toBe(true);
  });

  it('skips device ingest, static files and the service worker', () => {
    expect(matches('/api/ingest/counters/milesight')).toBe(false);
    expect(matches('/_next/static/chunks/a.js')).toBe(false);
    expect(matches('/sw.js')).toBe(false);
    expect(matches('/manifest.webmanifest')).toBe(false);
  });
});
