import type { DeviceRecord, IngestRepository } from './repository';
import { getDummyHash, SECRET_MAX_LENGTH, verifyDeviceSecret } from './secrets';

/**
 * Per-device HTTP Basic authentication.
 *
 * The device sends `Authorization: Basic base64(<device id>:<secret>)`; this
 * is what the VS135's HTTP(S) recipient "User" and "Password" fields are for
 * (see RUNBOOK). Whether the device sends the header up front or waits for a
 * 401 challenge is UNVERIFIED, so 401 responses carry `WWW-Authenticate`.
 *
 * Every attempt runs exactly two scrypt checks (one per rotation slot, a dummy
 * hash filling any empty slot or an unknown device), so the response time does
 * not reveal whether a device id exists, is inactive, or has one or two secrets.
 */

/** Foresite device ids: short, URL- and log-safe. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export const MAX_SECRETS_PER_DEVICE = 2;

export interface BasicCredentials {
  deviceId: string;
  secret: string;
}

/** Parse an Authorization header. Returns `null` for anything malformed. */
export function parseBasicAuth(header: string | null): BasicCredentials | null {
  if (header === null || header.length > 1024) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header.trim());
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 1) return null;
  const deviceId = decoded.slice(0, colon);
  const secret = decoded.slice(colon + 1);
  if (!DEVICE_ID_PATTERN.test(deviceId)) return null;
  if (secret.length === 0 || secret.length > SECRET_MAX_LENGTH) return null;
  return { deviceId, secret };
}

export type AuthResult =
  | { ok: true; device: DeviceRecord; slot: number }
  | { ok: false; reason: 'malformed' | 'unknown_device' | 'inactive' | 'bad_secret' };

export type VerifySecret = (secret: string, encodedHash: string) => Promise<boolean>;

export async function authenticateDevice(
  repository: IngestRepository,
  provider: string,
  header: string | null,
  verify: VerifySecret = verifyDeviceSecret,
): Promise<AuthResult> {
  const credentials = parseBasicAuth(header);
  const dummy = await getDummyHash();
  if (credentials === null) {
    // Same work as a real check, so malformed headers are not a fast path.
    await Promise.all([verify('', dummy), verify('', dummy)]);
    return { ok: false, reason: 'malformed' };
  }

  const device = await repository.findDevice(provider, credentials.deviceId);
  const hashes = device?.secretHashes.slice(0, MAX_SECRETS_PER_DEVICE) ?? [];
  const slots = Array.from({ length: MAX_SECRETS_PER_DEVICE }, (_, i) => hashes[i] ?? dummy);
  const results = await Promise.all(slots.map((hash) => verify(credentials.secret, hash)));
  // A slot only counts if it held a real hash.
  const slot = results.findIndex((matched, i) => matched && i < hashes.length);

  if (device === null) return { ok: false, reason: 'unknown_device' };
  if (slot === -1) return { ok: false, reason: 'bad_secret' };
  if (!device.active) return { ok: false, reason: 'inactive' };
  return { ok: true, device, slot: slot + 1 };
}
