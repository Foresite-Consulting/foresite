import { describe, expect, it } from 'vitest';
import { loadIngestConfig } from './config';

const HASH =
  'scrypt$v=1$n=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const memoryDevice = {
  provider: 'milesight',
  deviceId: 'dev-one',
  venueId: 'venue-a',
  entryPointId: 'front',
  secretHashes: [HASH],
};

describe('loadIngestConfig', () => {
  it('uses safe defaults', () => {
    const result = loadIngestConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@db.example:5432/postgres?sslmode=verify-full',
    });
    expect(result).toEqual({
      ok: true,
      config: {
        storage: {
          kind: 'postgres',
          url: 'postgresql://u:p@db.example:5432/postgres?sslmode=verify-full',
          caCert: null,
        },
        requireHttps: true,
        maxBodyBytes: 65_536,
        clock: { maxFutureMinutes: 10, maxAgeDays: 30, lateAfterMinutes: 15 },
        rateLimit: { capacity: 60, refillPerSecond: 1 },
        authFailuresPerMinute: 10,
      },
    });
  });

  it('only requires HTTPS in production', () => {
    const result = loadIngestConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost/db',
    });
    expect(result.ok && result.config.requireHttps).toBe(false);
  });

  it('fails closed without a database, or with unverified TLS in production', () => {
    expect(loadIngestConfig({})).toEqual({ ok: false, problems: ['DATABASE_URL'] });
    const plain = loadIngestConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@db.example/postgres?sslmode=require',
    });
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.problems[0]).toMatch(/^DATABASE_URL/);
    const withCa = loadIngestConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@db.example/postgres',
      DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----',
    });
    expect(withCa.ok).toBe(true);
  });

  it('never reports variable values, only names', () => {
    const result = loadIngestConfig({
      DATABASE_URL: 'mysql://user:hunter2@host/db',
      INGEST_MAX_BODY_BYTES: 'lots',
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    if (!result.ok) expect(result.problems).toEqual(['INGEST_MAX_BODY_BYTES']);
  });

  it('validates numeric limits', () => {
    for (const [name, value] of [
      ['INGEST_MAX_BODY_BYTES', '10'],
      ['INGEST_MAX_BODY_BYTES', '99999999'],
      ['INGEST_MAX_AGE_DAYS', '0'],
      ['INGEST_RATE_LIMIT_CAPACITY', '1.5'],
      ['INGEST_RATE_LIMIT_REFILL_PER_SECOND', '0'],
    ] as const) {
      const result = loadIngestConfig({ DATABASE_URL: 'postgres://localhost/db', [name]: value });
      expect(result.ok, `${name}=${value}`).toBe(false);
    }
    const tuned = loadIngestConfig({
      DATABASE_URL: 'postgres://localhost/db',
      INGEST_MAX_AGE_DAYS: '7',
      INGEST_RATE_LIMIT_REFILL_PER_SECOND: '0.5',
    });
    expect(tuned.ok && tuned.config.clock.maxAgeDays).toBe(7);
    expect(tuned.ok && tuned.config.rateLimit.refillPerSecond).toBe(0.5);
  });

  it('loads in-memory devices, but never on Vercel production', () => {
    const local = loadIngestConfig({
      INGEST_STORAGE: 'memory',
      INGEST_MEMORY_DEVICES: JSON.stringify([memoryDevice]),
    });
    expect(local.ok && local.config.storage).toEqual({
      kind: 'memory',
      devices: [{ ...memoryDevice, lineEntryPoints: {}, vendorSerial: null, active: true }],
    });
    const vercel = loadIngestConfig({ INGEST_STORAGE: 'memory', VERCEL_ENV: 'production' });
    expect(vercel.ok).toBe(false);
  });

  it('rejects memory devices with plain-text secrets or bad ids', () => {
    for (const device of [
      { ...memoryDevice, secretHashes: ['plain-secret'] },
      { ...memoryDevice, deviceId: 'a b' },
      { ...memoryDevice, secretHashes: [HASH, HASH, HASH] },
    ]) {
      const result = loadIngestConfig({
        INGEST_STORAGE: 'memory',
        INGEST_MEMORY_DEVICES: JSON.stringify([device]),
      });
      expect(result).toEqual({ ok: false, problems: ['INGEST_MEMORY_DEVICES'] });
    }
    expect(
      loadIngestConfig({ INGEST_STORAGE: 'memory', INGEST_MEMORY_DEVICES: '{not json' }).ok,
    ).toBe(false);
  });
});
