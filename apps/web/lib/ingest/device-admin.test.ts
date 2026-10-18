import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDeviceSql,
  finishRotationSql,
  memoryDeviceJson,
  parseDeviceArgs,
  rotateDeviceSql,
  sqlLiteral,
  UsageError,
} from './device-admin';
import { memoryDeviceSchema } from './config';
import { createMigratedPglite, fromPglite } from './pglite';
import { PostgresIngestRepository } from './postgres-repository';
import { generateDeviceSecret, hashDeviceSecret, verifyDeviceSecret } from './secrets';

const run = promisify(execFile);
const appDir = fileURLToPath(new URL('../..', import.meta.url));
const tsx = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url));

describe('parseDeviceArgs', () => {
  it('parses a create command with line mappings', () => {
    expect(
      parseDeviceArgs([
        '--device',
        'ven1-door-01',
        '--venue',
        'ven1',
        '--entry',
        'front',
        '--serial',
        'TEST123',
        '--line',
        '2=side-door',
      ]),
    ).toEqual({
      kind: 'create',
      deviceId: 'ven1-door-01',
      venueId: 'ven1',
      entryPointId: 'front',
      provider: 'milesight',
      vendorSerial: 'TEST123',
      lineEntryPoints: { '2': 'side-door' },
      memoryJson: false,
    });
  });

  it('parses rotation commands and help', () => {
    expect(parseDeviceArgs(['--rotate', '--device', 'ven1-door-01'])).toEqual({
      kind: 'rotate',
      deviceId: 'ven1-door-01',
    });
    expect(parseDeviceArgs(['--finish-rotation', '--device', 'ven1-door-01']).kind).toBe(
      'finish-rotation',
    );
    expect(parseDeviceArgs([]).kind).toBe('help');
  });

  it('refuses bad or injection-shaped input', () => {
    for (const args of [
      ['--device', "x'; drop table counter_devices; --", '--venue', 'v', '--entry', 'e'],
      ['--device', 'ok-device', '--venue', "v'", '--entry', 'e'],
      ['--device', 'ok-device', '--venue', 'v'],
      ['--device', 'ok-device', '--venue', 'v', '--entry', 'e', '--line', '2'],
      ['--device', 'ok-device', '--venue', 'v', '--entry', 'e', '--provider', 'Bad Name'],
      ['--device', 'ok-device', '--venue', 'v', '--entry', 'e', '--bogus'],
      ['--device'],
    ]) {
      expect(() => parseDeviceArgs(args), args.join(' ')).toThrow(UsageError);
    }
  });

  it('refuses line mappings that would put two lines on one entry point', () => {
    const base = ['--device', 'ok-device', '--venue', 'v', '--entry', 'front'];
    for (const extra of [
      ['--line', '2=front'],
      ['--line', '2=side', '--line', '3=side'],
      ['--line', '2=side', '--line', '2=back'],
      ['--line', '1=front:line-2'],
    ]) {
      expect(() => parseDeviceArgs([...base, ...extra]), extra.join(' ')).toThrow(UsageError);
    }
    // --entry given after --line is still checked.
    expect(() =>
      parseDeviceArgs([
        '--line',
        '2=front',
        '--device',
        'ok-device',
        '--venue',
        'v',
        '--entry',
        'front',
      ]),
    ).toThrow(/own entry point/);
    expect(parseDeviceArgs([...base, '--line', '2=side', '--line', '3=back']).kind).toBe('create');
  });

  it('doubles quotes in SQL literals', () => {
    expect(sqlLiteral("o'clock")).toBe("'o''clock'");
  });
});

describe('generated SQL against the real migration (PGlite)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createMigratedPglite();
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  it('registers a device the endpoint can authenticate, then rotates its secret', async () => {
    const command = parseDeviceArgs([
      '--device',
      'ven1-door-01',
      '--venue',
      'ven1',
      '--entry',
      'front',
      '--line',
      '2=side',
    ]);
    if (command.kind !== 'create') throw new Error('expected create');
    const first = generateDeviceSecret();
    await db.exec(createDeviceSql(command, await hashDeviceSecret(first)));

    const repo = new PostgresIngestRepository(fromPglite(db));
    let device = await repo.findDevice('milesight', 'ven1-door-01');
    expect(device).toMatchObject({
      venueId: 'ven1',
      lineEntryPoints: { '2': 'side' },
      active: true,
    });
    expect(await verifyDeviceSecret(first, device!.secretHashes[0]!)).toBe(true);

    const updatedAt = async () =>
      (
        await db.query<{ d: string; c: string }>(
          `select d.updated_at::text as d, c.updated_at::text as c
             from counter_devices d join counter_device_credentials c using (device_id)
            where device_id = 'ven1-door-01'`,
        )
      ).rows[0]!;
    await db.exec(`update counter_devices set updated_at = '2000-01-01T00:00:00Z';
      update counter_device_credentials set updated_at = '2000-01-01T00:00:00Z'`);

    // Step 2 before step 1: raises, changes nothing (review F8).
    await expect(db.exec(finishRotationSql('ven1-door-01'))).rejects.toThrow(
      /no rotation in progress \(0 rows updated, expected 1\)/,
    );
    const second = generateDeviceSecret();
    await db.exec(rotateDeviceSql('ven1-door-01', await hashDeviceSecret(second)));
    const touched = await updatedAt();
    expect(touched.d).not.toMatch(/^2000-/);
    expect(touched.c).not.toMatch(/^2000-/);
    // Running step 1 again while a rotation is in progress raises and changes nothing.
    await expect(
      db.exec(rotateDeviceSql('ven1-door-01', await hashDeviceSecret(generateDeviceSecret()))),
    ).rejects.toThrow(/rotation is already in progress/);
    // So does a typo in the device id.
    await expect(
      db.exec(rotateDeviceSql('ven1-door-0l', await hashDeviceSecret(generateDeviceSecret()))),
    ).rejects.toThrow(/device ven1-door-0l: unknown device/);
    device = await repo.findDevice('milesight', 'ven1-door-01');
    expect(device?.secretHashes).toHaveLength(2);
    expect(await verifyDeviceSecret(second, device!.secretHashes[1]!)).toBe(true);

    await db.exec(`update counter_devices set updated_at = '2000-01-01T00:00:00Z'`);
    await db.exec(finishRotationSql('ven1-door-01'));
    expect((await updatedAt()).d).not.toMatch(/^2000-/);
    device = await repo.findDevice('milesight', 'ven1-door-01');
    expect(device?.secretHashes).toHaveLength(1);
    expect(await verifyDeviceSecret(second, device!.secretHashes[0]!)).toBe(true);
    expect(await verifyDeviceSecret(first, device!.secretHashes[0]!)).toBe(false);
  });

  it('produces memory JSON that the config accepts', async () => {
    const command = parseDeviceArgs([
      '--device',
      'ven1-door-02',
      '--venue',
      'ven1',
      '--entry',
      'side',
    ]);
    if (command.kind !== 'create') throw new Error('expected create');
    const json = memoryDeviceJson(command, await hashDeviceSecret(generateDeviceSecret()));
    expect(memoryDeviceSchema.safeParse(JSON.parse(json)).success).toBe(true);
  });
});

describe('device:create script', () => {
  it('prints the secret once on stderr and only the hash on stdout', async () => {
    const { stdout, stderr } = await run(
      tsx,
      [
        'scripts/device-create.ts',
        '--device',
        'ven1-door-01',
        '--venue',
        'ven1',
        '--entry',
        'front',
      ],
      { cwd: appDir },
    );
    const secret = /Password: ([A-Za-z0-9]{40})/.exec(stderr)?.[1];
    expect(secret).toBeDefined();
    expect(stderr.split(secret!).length - 1).toBe(1);
    expect(stdout).not.toContain(secret);
    const hash = /array\['(scrypt\$[^']+)'\]/.exec(stdout)?.[1];
    expect(hash).toBeDefined();
    expect(await verifyDeviceSecret(secret!, hash!)).toBe(true);
  }, 30_000);

  it('warns on stderr that a rotation secret only works if the SQL succeeds', async () => {
    const { stdout, stderr } = await run(
      tsx,
      ['scripts/device-create.ts', '--rotate', '--device', 'ven1-door-01'],
      { cwd: appDir },
    );
    expect(stdout).toContain('raise exception');
    expect(stderr).toMatch(/WARNING: this secret only works once the SQL above has run/);
    expect(stdout).not.toContain('WARNING');
  }, 30_000);

  it('exits 2 with usage on bad input', async () => {
    await expect(
      run(tsx, ['scripts/device-create.ts', '--device', 'x'], { cwd: appDir }),
    ).rejects.toMatchObject({
      code: 2,
    });
  }, 30_000);
});
