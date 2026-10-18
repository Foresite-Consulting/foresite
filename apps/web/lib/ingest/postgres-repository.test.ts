import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
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

  it('only stores secret hashes in the scrypt format (review F6)', async () => {
    const [real] = CONTRACT_DEVICE.secretHashes;
    const set = (hashes: string[]) =>
      db.query(
        `update counter_device_credentials set secret_hashes = $2::text[] where device_id = $1`,
        [CONTRACT_DEVICE.deviceId, hashes],
      );
    for (const bad of [
      ['a-plain-secret-pasted-by-mistake'],
      [`${real} `],
      [`${real}`, 'not-a-hash'],
      [`${real} ${real}`],
      ['scrypt$v=1$n=16384,r=8,p=1$short$short'],
      [real!.replace('scrypt$v=1', 'scrypt$v=2')],
    ]) {
      await expect(set(bad), bad.join(',')).rejects.toThrow(
        /counter_device_credentials_scrypt_format/,
      );
    }
    // An array indexed from 2, so secret_hashes[1] is null.
    await expect(
      db.query(
        `update counter_device_credentials set secret_hashes = $2::text[] where device_id = $1`,
        [CONTRACT_DEVICE.deviceId, `[2:2]={"${real!}"}`],
      ),
    ).rejects.toThrow(/counter_device_credentials_scrypt_format/);
    await set([real!]);
    await set([real!, real!]);
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

  it('revokes table and sequence privileges from the Supabase API roles (review F6)', async () => {
    // A fresh database set up like Supabase: anon/authenticated exist and get
    // privileges on new tables and sequences by default.
    const supa = await PGlite.create();
    try {
      await supa.exec(`
        create role anon nologin;
        create role authenticated nologin;
        alter default privileges in schema public grant all on tables to anon, authenticated;
        alter default privileges in schema public grant all on sequences to anon, authenticated;
      `);
      await supa.exec(readFileSync(MIGRATION_PATH, 'utf8'));
      const { rows } = await supa.query<{ role: string; object: string; allowed: boolean }>(
        `select r.role, s.object,
                case when s.kind = 'S'
                  then has_sequence_privilege(r.role, s.object, 'usage')
                    or has_sequence_privilege(r.role, s.object, 'select')
                    or has_sequence_privilege(r.role, s.object, 'update')
                  else has_table_privilege(r.role, s.object, 'select')
                    or has_table_privilege(r.role, s.object, 'insert')
                    or has_table_privilege(r.role, s.object, 'update')
                    or has_table_privilege(r.role, s.object, 'delete')
                end as allowed
           from (values ('anon'), ('authenticated')) r(role)
           cross join (select relname::text as object, relkind::text as kind from pg_class
                        where relname like 'counter\\_%' and relkind in ('r', 'S')) s
          order by 1, 2`,
      );
      // 5 tables + 3 identity sequences, for each role.
      expect(rows).toHaveLength(16);
      expect(rows.filter((r) => r.object.endsWith('_seq'))).toHaveLength(6);
      expect(rows.filter((r) => r.allowed)).toEqual([]);
    } finally {
      await supa.close();
    }
  }, 60_000);

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
