import { DEVICE_ID_PATTERN } from './auth';
import { parseSecretHash } from './secrets';

/**
 * Pure helpers behind `npm run device:create -w apps/web`. They build SQL for
 * an operator to run in the client's Supabase SQL editor; nothing here
 * connects to a database or writes files.
 */

export type DeviceCommand =
  | {
      kind: 'create';
      deviceId: string;
      venueId: string;
      entryPointId: string;
      provider: string;
      vendorSerial: string | null;
      lineEntryPoints: Record<string, string>;
      memoryJson: boolean;
    }
  | { kind: 'rotate'; deviceId: string }
  | { kind: 'finish-rotation'; deviceId: string }
  | { kind: 'help' };

const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PROVIDER = /^[a-z0-9_-]{1,32}$/;
const SERIAL = /^[A-Za-z0-9._-]{1,64}$/;

export const USAGE = `Register a people counter, or rotate its secret.

  npm run device:create -w apps/web -- --device <id> --venue <id> --entry <id>
      [--provider milesight] [--serial <vendor serial>] [--line <n>=<entry id> ...] [--memory-json]
  npm run device:create -w apps/web -- --rotate --device <id>
  npm run device:create -w apps/web -- --finish-rotation --device <id>

The secret is printed once, to the terminal (stderr). SQL goes to stdout.
Nothing is written to disk.`;

export class UsageError extends Error {}

function take(args: string[], i: number, flag: string): string {
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
  return value;
}

export function parseDeviceArgs(args: string[]): DeviceCommand {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) return { kind: 'help' };
  const values: Record<string, string> = {};
  const lines: Record<string, string> = {};
  let mode: 'create' | 'rotate' | 'finish-rotation' = 'create';
  let memoryJson = false;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case '--device':
      case '--venue':
      case '--entry':
      case '--provider':
      case '--serial':
        values[flag.slice(2)] = take(args, i, flag);
        i += 1;
        break;
      case '--line': {
        const spec = take(args, i, flag);
        i += 1;
        const match = /^(\d{1,2})=(.+)$/.exec(spec);
        if (!match?.[1] || !match[2] || !SHORT_ID.test(match[2])) {
          throw new UsageError('--line needs <line number>=<entry id>');
        }
        lines[String(Number(match[1]))] = match[2];
        break;
      }
      case '--rotate':
        mode = 'rotate';
        break;
      case '--finish-rotation':
        mode = 'finish-rotation';
        break;
      case '--memory-json':
        memoryJson = true;
        break;
      default:
        throw new UsageError(`unknown option ${String(flag)}`);
    }
  }

  const deviceId = values.device;
  if (deviceId === undefined || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new UsageError(
      '--device must be 3-64 characters: letters, digits, dot, dash, underscore',
    );
  }
  if (mode !== 'create') return { kind: mode, deviceId };

  const venueId = values.venue;
  const entryPointId = values.entry;
  const provider = values.provider ?? 'milesight';
  const serial = values.serial ?? null;
  if (venueId === undefined || !SHORT_ID.test(venueId)) throw new UsageError('--venue is required');
  if (entryPointId === undefined || !SHORT_ID.test(entryPointId)) {
    throw new UsageError('--entry is required');
  }
  if (!PROVIDER.test(provider)) throw new UsageError('--provider is not valid');
  if (serial !== null && !SERIAL.test(serial)) throw new UsageError('--serial is not valid');
  return {
    kind: 'create',
    deviceId,
    venueId,
    entryPointId,
    provider,
    vendorSerial: serial,
    lineEntryPoints: lines,
    memoryJson,
  };
}

/** Single-quoted SQL literal. Inputs are already validated; quoting is belt and braces. */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertHash(hash: string): void {
  if (parseSecretHash(hash) === null) throw new Error('not a valid secret hash');
}

export function createDeviceSql(
  command: Extract<DeviceCommand, { kind: 'create' }>,
  hash: string,
): string {
  assertHash(hash);
  const serial = command.vendorSerial === null ? 'null' : sqlLiteral(command.vendorSerial);
  return `-- Register counter ${command.deviceId} (venue ${command.venueId}, entry ${command.entryPointId}).
begin;
insert into counter_devices
  (device_id, provider, venue_id, entry_point_id, line_entry_points, vendor_serial, active)
values
  (${sqlLiteral(command.deviceId)}, ${sqlLiteral(command.provider)}, ${sqlLiteral(command.venueId)},
   ${sqlLiteral(command.entryPointId)}, ${sqlLiteral(JSON.stringify(command.lineEntryPoints))}::jsonb,
   ${serial}, true);
insert into counter_device_credentials (device_id, venue_id, secret_hashes)
values (${sqlLiteral(command.deviceId)}, ${sqlLiteral(command.venueId)}, array[${sqlLiteral(hash)}]);
commit;
`;
}

export function rotateDeviceSql(deviceId: string, hash: string): string {
  assertHash(hash);
  return `-- Step 1 of 2: add a second secret for ${deviceId}. Both work until step 2.
-- Updates nothing if a rotation is already in progress (two secrets stored).
update counter_device_credentials
   set secret_hashes = array[secret_hashes[1], ${sqlLiteral(hash)}], updated_at = now()
 where device_id = ${sqlLiteral(deviceId)} and cardinality(secret_hashes) = 1;
-- Then enter the new secret on the device and check the logs show "secretSlot":2.
`;
}

export function finishRotationSql(deviceId: string): string {
  return `-- Step 2 of 2: drop the old secret for ${deviceId}, keeping the new one.
-- Only run this once the logs show the device using "secretSlot":2.
update counter_device_credentials
   set secret_hashes = array[secret_hashes[2]], updated_at = now()
 where device_id = ${sqlLiteral(deviceId)} and cardinality(secret_hashes) = 2;
`;
}

/** A device entry for `INGEST_MEMORY_DEVICES` (local runs only). Hash only, never the secret. */
export function memoryDeviceJson(
  command: Extract<DeviceCommand, { kind: 'create' }>,
  hash: string,
): string {
  assertHash(hash);
  return JSON.stringify({
    provider: command.provider,
    deviceId: command.deviceId,
    venueId: command.venueId,
    entryPointId: command.entryPointId,
    lineEntryPoints: command.lineEntryPoints,
    vendorSerial: command.vendorSerial,
    active: true,
    secretHashes: [hash],
  });
}
