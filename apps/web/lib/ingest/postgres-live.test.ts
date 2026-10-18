import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_PATH, seedDevice } from './pglite';
import {
  fromPostgresJs,
  PostgresIngestRepository,
  type PostgresJsLike,
} from './postgres-repository';
import { batch, CONTRACT_DEVICE, describeRepositoryContract, reading } from './repository.contract';

/**
 * Optional: the same contract against a real PostgreSQL server through the
 * production driver (postgres.js), plus a concurrency check across separate
 * connections that PGlite (single connection) cannot do.
 *
 * Runs only when TEST_DATABASE_URL points at a server where the user may
 * create databases, e.g. postgres://postgres@127.0.0.1:5432/postgres.
 * A throwaway database is created and dropped. Skipped in CI.
 */

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(adminUrl === undefined)('postgres.js against a real server', () => {
  const dbName = `foresite_test_${randomBytes(6).toString('hex')}`;
  let admin: ReturnType<typeof postgres>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create database ${dbName}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    // The migration has its own begin/commit, which postgres.js only allows on one connection.
    const migrator = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    await migrator.unsafe(readFileSync(MIGRATION_PATH, 'utf8'));
    await migrator.end();
    sql = postgres(url.toString(), { max: 5, prepare: false, onnotice: () => undefined });
  }, 60_000);

  afterAll(async () => {
    await sql.end();
    await admin.unsafe(`drop database if exists ${dbName}`);
    await admin.end();
  });

  const client = () => fromPostgresJs(sql as unknown as PostgresJsLike);

  describeRepositoryContract('postgres.js (live server)', async () => {
    await sql.unsafe(`truncate counter_ingest_events, counter_readings, counter_raw_payloads,
      counter_device_credentials, counter_devices restart identity cascade`);
    return {
      repository: new PostgresIngestRepository(client()),
      seed: (d) => seedDevice(client(), d),
    };
  });

  it('keeps one row per key when many connections re-send the same interval at once', async () => {
    await sql.unsafe(`truncate counter_ingest_events, counter_readings, counter_raw_payloads,
      counter_device_credentials, counter_devices restart identity cascade`);
    await seedDevice(client(), CONTRACT_DEVICE);
    const repo = new PostgresIngestRepository(client());
    const hashes = Array.from({ length: 10 }, (_, i) => i.toString(16).padStart(64, '0'));
    const results = await Promise.all(
      hashes.map((hash, i) => repo.ingest(batch(hash, [reading(0, { in: 5 + (i % 2), out: 1 })]))),
    );
    const kinds = results.flatMap((r) => r.outcomes.map((o) => o.kind));
    expect(kinds.filter((k) => k === 'accepted')).toHaveLength(1);
    expect(await repo.listReadings(CONTRACT_DEVICE.deviceId)).toHaveLength(1);
    const conflicts = (await repo.listEvents(CONTRACT_DEVICE.deviceId)).filter(
      (e) => e.type === 'reading_conflict',
    );
    expect(conflicts.length).toBe(kinds.filter((k) => k === 'conflict').length);
  }, 30_000);
});
