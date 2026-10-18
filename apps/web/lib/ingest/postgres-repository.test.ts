import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedPglite, fromPglite, MIGRATION_PATH, seedDevice } from './pglite';
import { PostgresIngestRepository } from './postgres-repository';
import { batch, CONTRACT_DEVICE, describeRepositoryContract, reading } from './repository.contract';

// PGlite takes a few seconds to start, so one instance serves the file and
// each test starts from empty tables.
let db: PGlite;

beforeAll(async () => {
  db = await createMigratedPglite();
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function truncate() {
  await db.exec(`truncate counter_ingest_events, counter_readings, counter_raw_payloads,
    counter_device_credentials, counter_devices restart identity cascade`);
}

describeRepositoryContract('postgres (PGlite)', async () => {
  await truncate();
  const client = fromPglite(db);
  return { repository: new PostgresIngestRepository(client), seed: (d) => seedDevice(client, d) };
});

describe('migration 0001_counter_ingest.sql', () => {
  beforeAll(truncate);

  it('creates the five counter tables with row-level security enabled', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
        where relname like 'counter\\_%' and relkind = 'r' order by relname`,
    );
    expect(rows).toEqual([
      { relname: 'counter_device_credentials', relrowsecurity: true },
      { relname: 'counter_devices', relrowsecurity: true },
      { relname: 'counter_ingest_events', relrowsecurity: true },
      { relname: 'counter_raw_payloads', relrowsecurity: true },
      { relname: 'counter_readings', relrowsecurity: true },
    ]);
  });

  it('puts venue_id on every table, not null', async () => {
    const { rows } = await db.query<{ table_name: string; is_nullable: string }>(
      `select table_name, is_nullable from information_schema.columns
        where table_name like 'counter\\_%' and column_name = 'venue_id' order by table_name`,
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.is_nullable === 'NO')).toBe(true);
  });

  it('enforces the natural key, positive intervals and non-negative counts', async () => {
    const client = fromPglite(db);
    await seedDevice(client, CONTRACT_DEVICE);
    const repo = new PostgresIngestRepository(client);
    await repo.ingest(batch('b'.repeat(64), [reading(0, { in: 1, out: 1 })]));

    const insert = (overrides: Record<string, unknown>) => {
      const row = {
        venue_id: CONTRACT_DEVICE.venueId,
        device_id: CONTRACT_DEVICE.deviceId,
        entry_point_id: 'front',
        source_line: '1',
        interval_start: '2026-10-17T11:00:00Z',
        interval_end: '2026-10-17T11:05:00Z',
        count_in: 1,
        count_out: 1,
        device_reported_at: '2026-10-17T11:05:00Z',
        received_at: '2026-10-17T11:05:02Z',
        raw_payload_hash: 'b'.repeat(64),
        ...overrides,
      };
      const columns = Object.keys(row);
      return db.query(
        `insert into counter_readings (${columns.join(', ')})
         values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    await expect(insert({})).rejects.toThrow(/counter_readings_natural_key/);
    await expect(
      insert({ interval_start: '2026-10-17T12:00:00Z', interval_end: '2026-10-17T12:00:00Z' }),
    ).rejects.toThrow(/check/i);
    await expect(
      insert({
        interval_start: '2026-10-17T13:00:00Z',
        interval_end: '2026-10-17T13:05:00Z',
        count_in: -1,
      }),
    ).rejects.toThrow(/check/i);
    await expect(
      insert({
        interval_start: '2026-10-17T14:00:00Z',
        interval_end: '2026-10-17T14:05:00Z',
        raw_payload_hash: 'c'.repeat(64),
      }),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      insert({
        interval_start: '2026-10-17T15:00:00Z',
        interval_end: '2026-10-17T15:05:00Z',
        venue_id: 'another-venue',
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it('keeps at most two secret hashes per device', async () => {
    await expect(
      db.query(
        `update counter_device_credentials set secret_hashes = array['a','b','c'] where device_id = $1`,
        [CONTRACT_DEVICE.deviceId],
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      db.query(
        `update counter_device_credentials set secret_hashes = array[]::text[] where device_id = $1`,
        [CONTRACT_DEVICE.deviceId],
      ),
    ).rejects.toThrow(/check/i);
  });

  it('only allows known event types', async () => {
    await expect(
      db.query(
        `insert into counter_ingest_events (venue_id, device_id, event_type) values ($1, $2, 'made_up')`,
        [CONTRACT_DEVICE.venueId, CONTRACT_DEVICE.deviceId],
      ),
    ).rejects.toThrow(/check/i);
  });

  it('denies a role without privileges, even with RLS policies absent', async () => {
    await db.exec(`create role app_user nologin`);
    await db.exec(`grant select on counter_readings to app_user`);
    await db.exec(`set role app_user`);
    try {
      const { rows } = await db.query(`select * from counter_readings`);
      // Granted the table but no policy: RLS hides every row.
      expect(rows).toEqual([]);
      await expect(db.query(`select * from counter_device_credentials`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await db.exec(`reset role`);
    }
  });

  it('is a single transaction (begin/commit) so a failure leaves nothing behind', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(
      sql
        .trimStart()
        .split('\n')
        .find((l) => !l.startsWith('--') && l.trim() !== ''),
    ).toBe('begin;');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
  });
});
