import 'server-only';
import postgres from 'postgres';
import { VerifiedCredentialCache } from './auth-cache';
import { loadIngestConfig, type IngestConfig } from './config';
import type { IngestDeps } from './handler';
import { consoleIngestLogger } from './log';
import { MemoryIngestRepository } from './memory-repository';
import {
  fromPostgresJs,
  PostgresIngestRepository,
  type PostgresJsLike,
} from './postgres-repository';
import { MemoryTokenBucket } from './rate-limit';

/**
 * Builds the ingest dependencies once per server instance from the
 * environment. Server-only: this module holds the database connection.
 */

let cached: IngestDeps | undefined;

function postgresClient(config: Extract<IngestConfig['storage'], { kind: 'postgres' }>) {
  return postgres(config.url, {
    // Serverless functions: few connections each, through the Supabase pooler.
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    // Transaction-mode poolers do not support prepared statements.
    prepare: false,
    ...(config.caCert !== null ? { ssl: { ca: config.caCert, rejectUnauthorized: true } } : {}),
    connection: { application_name: 'foresite-counter-ingest' },
  });
}

export function getIngestDeps(): IngestDeps {
  if (cached) return cached;
  const result = loadIngestConfig(process.env);
  if (!result.ok) {
    // Variable names only, never values.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'counter_ingest_config',
        problems: result.problems,
      }),
    );
    // Fail closed, but do not cache: a fixed environment takes effect on the next cold start.
    return {
      repository: null,
      deviceLimiter: new MemoryTokenBucket({ capacity: 1, refillPerSecond: 1 }),
      authFailureLimiter: new MemoryTokenBucket({ capacity: 1, refillPerSecond: 1 }),
      clock: { maxFutureMinutes: 10, maxAgeDays: 30, lateAfterMinutes: 15 },
      maxBodyBytes: 65_536,
      requireHttps: process.env.NODE_ENV === 'production',
      now: Date.now,
      logger: consoleIngestLogger,
    };
  }
  const { config } = result;
  const repository =
    config.storage.kind === 'memory'
      ? new MemoryIngestRepository(config.storage.devices)
      : new PostgresIngestRepository(
          fromPostgresJs(postgresClient(config.storage) as unknown as PostgresJsLike),
        );
  if (config.storage.kind === 'memory' && process.env.NODE_ENV === 'production') {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'counter_ingest_config',
        message: 'in-memory storage: readings are lost on restart',
      }),
    );
  }

  cached = {
    repository,
    deviceLimiter: new MemoryTokenBucket(config.rateLimit),
    authFailureLimiter: new MemoryTokenBucket({
      capacity: config.authFailuresPerMinute,
      refillPerSecond: config.authFailuresPerMinute / 60,
    }),
    authFailureAddressLimiter: new MemoryTokenBucket({
      capacity: config.authFailuresPerAddressPerMinute,
      refillPerSecond: config.authFailuresPerAddressPerMinute / 60,
    }),
    clock: config.clock,
    maxBodyBytes: config.maxBodyBytes,
    requireHttps: config.requireHttps,
    now: Date.now,
    logger: consoleIngestLogger,
    authCache: new VerifiedCredentialCache(),
  };
  return cached;
}
