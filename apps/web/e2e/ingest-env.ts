import { randomBytes, scryptSync } from 'node:crypto';

/**
 * Synthetic devices for the Playwright server (INGEST_STORAGE=memory). The
 * secret is random per run and never written anywhere; the server only sees
 * its scrypt hash. Each project and retry gets its own devices so tests do
 * not share rate-limit buckets or readings.
 */

export const E2E_PROJECTS = ['phone-light', 'desktop-dark'] as const;
export const E2E_ROLES = ['main', 'replay', 'limit'] as const;
export const E2E_RETRIES = 2;
/** Small, so the 429 test needs few requests. */
export const E2E_RATE_CAPACITY = 8;

export function e2eDeviceId(project: string, role: string, retry: number): string {
  return `e2e-${project}-${role}-${retry}`;
}

function hash(secret: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(secret, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$v=1$n=16384,r=8,p=1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Sets E2E_INGEST_SECRET for the test workers and returns the server's env. */
export function ingestServerEnv(): Record<string, string> {
  const secret = process.env.E2E_INGEST_SECRET ?? randomBytes(30).toString('base64url');
  process.env.E2E_INGEST_SECRET = secret;
  const secretHash = hash(secret);
  const devices = E2E_PROJECTS.flatMap((project) =>
    E2E_ROLES.flatMap((role) =>
      Array.from({ length: E2E_RETRIES }, (_, retry) => ({
        provider: 'milesight',
        deviceId: e2eDeviceId(project, role, retry),
        venueId: 'e2e-venue',
        entryPointId: 'front',
        vendorSerial: 'TEST0000000001',
        secretHashes: [secretHash],
      })),
    ),
  );
  return {
    INGEST_STORAGE: 'memory',
    INGEST_MEMORY_DEVICES: JSON.stringify(devices),
    INGEST_RATE_LIMIT_CAPACITY: String(E2E_RATE_CAPACITY),
    INGEST_RATE_LIMIT_REFILL_PER_SECOND: '0.01',
    INGEST_AUTH_FAILURES_PER_MINUTE: '200',
  };
}
