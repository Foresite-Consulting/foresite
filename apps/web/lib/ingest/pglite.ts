import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { SqlClient, SqlExecutor } from './postgres-repository';
import type { DeviceRecord } from './repository';

/**
 * Test-only helpers: an in-process PostgreSQL (PGlite) with the counter
 * migration applied. Never imported by app code.
 */

export const MIGRATION_PATH = fileURLToPath(
  new URL('../../../../db/migrations/0001_counter_ingest.sql', import.meta.url),
);

export async function createMigratedPglite(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(readFileSync(MIGRATION_PATH, 'utf8'));
  return db;
}

interface PgliteLike {
  query: PGlite['query'];
}

function executor(db: PgliteLike): SqlExecutor {
  return {
    async query<T extends object>(text: string, params: readonly unknown[] = []) {
      return (await db.query<T>(text, [...params])).rows;
    },
  };
}

export function fromPglite(db: PGlite): SqlClient {
  return {
    ...executor(db),
    transaction: (work) => db.transaction((tx) => work(executor(tx))),
  };
}

/** Insert a device and its credentials, as the `device:create` SQL would. */
export async function seedDevice(db: SqlExecutor, device: DeviceRecord): Promise<void> {
  await db.query(
    `insert into counter_devices
       (device_id, provider, venue_id, entry_point_id, line_entry_points, vendor_serial, active)
     values ($1::text, $2::text, $3::text, $4::text, $5::text::jsonb, $6::text, $7::boolean)`,
    [
      device.deviceId,
      device.provider,
      device.venueId,
      device.entryPointId,
      JSON.stringify(device.lineEntryPoints),
      device.vendorSerial,
      device.active,
    ],
  );
  await db.query(
    `insert into counter_device_credentials (device_id, venue_id, secret_hashes)
     values ($1::text, $2::text, (select array_agg(value) from jsonb_array_elements_text($3::text::jsonb)))`,
    [device.deviceId, device.venueId, JSON.stringify(device.secretHashes)],
  );
}
