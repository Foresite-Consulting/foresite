/**
 * npm run device:create -w apps/web -- --device <id> --venue <id> --entry <id>
 *
 * Generates a strong random secret for a people counter, prints it ONCE to
 * the terminal (stderr), and prints SQL with only the scrypt hash to stdout.
 * Nothing is written to disk and nothing connects to a database: an operator
 * runs the SQL in the client's Supabase SQL editor. See the Milesight
 * RUNBOOK for where the device id and secret go on the device.
 */
import {
  createDeviceSql,
  finishRotationSql,
  memoryDeviceJson,
  parseDeviceArgs,
  rotateDeviceSql,
  USAGE,
  UsageError,
} from '../lib/ingest/device-admin';
import { generateDeviceSecret, hashDeviceSecret } from '../lib/ingest/secrets';

function printSecret(deviceId: string, secret: string): void {
  process.stderr.write(
    [
      '',
      `Device ${deviceId}: secret shown once. Copy it into the device now.`,
      `  HTTP(S) recipient User:     ${deviceId}`,
      `  HTTP(S) recipient Password: ${secret}`,
      'It is not stored anywhere. If it is lost, rotate the secret.',
      '',
    ].join('\n') + '\n',
  );
}

async function main(argv: string[]): Promise<number> {
  let command;
  try {
    command = parseDeviceArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }

  switch (command.kind) {
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case 'finish-rotation':
      process.stdout.write(finishRotationSql(command.deviceId));
      return 0;
    case 'rotate': {
      const secret = generateDeviceSecret();
      const hash = await hashDeviceSecret(secret);
      process.stdout.write(rotateDeviceSql(command.deviceId, hash));
      printSecret(command.deviceId, secret);
      return 0;
    }
    case 'create': {
      const secret = generateDeviceSecret();
      const hash = await hashDeviceSecret(secret);
      process.stdout.write(
        command.memoryJson
          ? `${memoryDeviceJson(command, hash)}\n`
          : createDeviceSql(command, hash),
      );
      printSecret(command.deviceId, secret);
      return 0;
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write('device:create failed\n');
    process.exitCode = 1;
  },
);
