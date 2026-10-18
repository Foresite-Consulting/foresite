import { z } from 'zod';
import { DEVICE_ID_PATTERN, MAX_SECRETS_PER_DEVICE } from './auth';
import { DEFAULT_CLOCK_POLICY, type ClockPolicy } from './clock';
import type { DeviceRecord } from './repository';
import { parseSecretHash } from './secrets';

/**
 * Ingest settings from environment variables (all listed in `.env.example`).
 * Parsed once per server instance. Invalid settings fail closed: the endpoint
 * answers 503 and logs which variable is wrong (by name, never by value).
 */

const intFrom = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return fallback;
      const n = Number(value);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `integer ${min}..${max}` });
        return z.NEVER;
      }
      return n;
    });

const numberFrom = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return fallback;
      const n = Number(value);
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `number ${min}..${max}` });
        return z.NEVER;
      }
      return n;
    });

const idString = z.string().regex(DEVICE_ID_PATTERN);
const shortId = z.string().min(1).max(64);

/** Devices for `INGEST_STORAGE=memory` only (local runs and the Playwright server). */
export const memoryDeviceSchema = z.object({
  provider: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  deviceId: idString,
  venueId: shortId,
  entryPointId: shortId,
  lineEntryPoints: z.record(z.string().regex(/^\d{1,2}$/), shortId).default({}),
  vendorSerial: z.string().min(1).max(64).nullable().default(null),
  active: z.boolean().default(true),
  secretHashes: z
    .array(z.string().refine((h) => parseSecretHash(h) !== null, 'not a scrypt hash'))
    .min(1)
    .max(MAX_SECRETS_PER_DEVICE),
});

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  VERCEL_ENV: z.string().optional(),
  INGEST_STORAGE: z.enum(['postgres', 'memory']).default('postgres'),
  DATABASE_URL: z.string().optional(),
  DATABASE_CA_CERT: z.string().optional(),
  INGEST_MEMORY_DEVICES: z.string().optional(),
  INGEST_MAX_BODY_BYTES: intFrom(65_536, 1_024, 1_048_576),
  INGEST_MAX_FUTURE_MINUTES: intFrom(DEFAULT_CLOCK_POLICY.maxFutureMinutes, 1, 1_440),
  INGEST_MAX_AGE_DAYS: intFrom(DEFAULT_CLOCK_POLICY.maxAgeDays, 1, 366),
  INGEST_LATE_AFTER_MINUTES: intFrom(DEFAULT_CLOCK_POLICY.lateAfterMinutes, 1, 10_080),
  INGEST_RATE_LIMIT_CAPACITY: intFrom(60, 1, 100_000),
  INGEST_RATE_LIMIT_REFILL_PER_SECOND: numberFrom(1, 0.001, 1_000),
  INGEST_AUTH_FAILURES_PER_MINUTE: intFrom(10, 1, 10_000),
});

export type IngestStorageConfig =
  | { kind: 'memory'; devices: DeviceRecord[] }
  | { kind: 'postgres'; url: string; caCert: string | null };

export interface IngestConfig {
  storage: IngestStorageConfig;
  requireHttps: boolean;
  maxBodyBytes: number;
  clock: ClockPolicy;
  rateLimit: { capacity: number; refillPerSecond: number };
  authFailuresPerMinute: number;
}

export type ConfigResult = { ok: true; config: IngestConfig } | { ok: false; problems: string[] };

/** TLS modes in a connection string that verify the server certificate. */
function verifiesCertificate(url: string): boolean {
  try {
    const mode = new URL(url).searchParams.get('sslmode');
    return mode === 'verify-full';
  } catch {
    return false;
  }
}

export function loadIngestConfig(env: Record<string, string | undefined>): ConfigResult {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Variable names only.
    return { ok: false, problems: [...new Set(parsed.error.issues.map((i) => String(i.path[0])))] };
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const problems: string[] = [];

  let storage: IngestStorageConfig | null = null;
  if (e.INGEST_STORAGE === 'memory') {
    if (e.VERCEL_ENV === 'production')
      problems.push('INGEST_STORAGE (memory is not allowed on Vercel production)');
    let devices: DeviceRecord[] = [];
    if (e.INGEST_MEMORY_DEVICES !== undefined && e.INGEST_MEMORY_DEVICES.trim() !== '') {
      try {
        const list = z
          .array(memoryDeviceSchema)
          .max(1_000)
          .safeParse(JSON.parse(e.INGEST_MEMORY_DEVICES));
        if (list.success) devices = list.data;
        else problems.push('INGEST_MEMORY_DEVICES');
      } catch {
        problems.push('INGEST_MEMORY_DEVICES');
      }
    }
    storage = { kind: 'memory', devices };
  } else {
    const url = e.DATABASE_URL?.trim() ?? '';
    const caCert = e.DATABASE_CA_CERT?.trim() ? e.DATABASE_CA_CERT : null;
    if (!/^postgres(ql)?:\/\//.test(url)) {
      problems.push('DATABASE_URL');
    } else if (production && caCert === null && !verifiesCertificate(url)) {
      // Never connect to the database over unverified TLS in production.
      problems.push('DATABASE_URL (needs sslmode=verify-full, or set DATABASE_CA_CERT)');
    } else {
      storage = { kind: 'postgres', url, caCert };
    }
  }

  if (problems.length > 0 || storage === null) return { ok: false, problems };
  return {
    ok: true,
    config: {
      storage,
      requireHttps: production,
      maxBodyBytes: e.INGEST_MAX_BODY_BYTES,
      clock: {
        maxFutureMinutes: e.INGEST_MAX_FUTURE_MINUTES,
        maxAgeDays: e.INGEST_MAX_AGE_DAYS,
        lateAfterMinutes: e.INGEST_LATE_AFTER_MINUTES,
      },
      rateLimit: {
        capacity: e.INGEST_RATE_LIMIT_CAPACITY,
        refillPerSecond: e.INGEST_RATE_LIMIT_REFILL_PER_SECOND,
      },
      authFailuresPerMinute: e.INGEST_AUTH_FAILURES_PER_MINUTE,
    },
  };
}
