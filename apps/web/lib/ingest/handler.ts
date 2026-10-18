import { randomUUID } from 'node:crypto';
import { getCounterAdapter, hashPayload } from '@foresite/connectors/counters';
import { authenticateDevice, parseBasicAuth } from './auth';
import type { VerifiedCredentialCache } from './auth-cache';
import { judgeReadingClock, type ClockPolicy } from './clock';
import {
  clientAddress,
  firstForwardedValue,
  isJsonContentType,
  jsonResponse,
  readBodyWithLimit,
} from './http';
import { checkJsonSafety } from './json-safety';
import type { IngestLogEntry, IngestLogger } from './log';
import type { RateLimiter } from './rate-limit';
import type {
  IngestBatchResult,
  IngestEventToStore,
  IngestRepository,
  RawPayloadToStore,
  ReadingToStore,
} from './repository';

/**
 * POST /api/ingest/counters/<provider>
 *
 * Order of checks, cheapest first and nothing read from the body before the
 * device has authenticated:
 *   HTTPS (production) → provider → Content-Type → Content-Length → storage
 *   configured → failed-login limits (address + claimed device id, then a
 *   looser per-address backstop; skipped for a recently verified credential) → HTTP Basic
 *   device auth → per-device rate limit → body size while streaming → JSON →
 *   vendor schema → serial check → clock sanity → store (deduplicated).
 *
 * Responses carry only fixed error codes. Nothing from the request is echoed.
 */

export interface IngestDeps {
  /** `null` when no storage is configured: every request gets 503. */
  repository: IngestRepository | null;
  deviceLimiter: RateLimiter;
  /**
   * Failed logins per client address AND claimed device id. Strict. Keyed on
   * both so one misconfigured device behind a shared address (carrier-grade
   * NAT on 4G) cannot lock out the others.
   */
  authFailureLimiter: RateLimiter;
  /**
   * Failed logins per client address, any device id. Looser: the backstop
   * against spraying many device ids from one address. Omit to disable.
   */
  authFailureAddressLimiter?: RateLimiter;
  clock: ClockPolicy;
  maxBodyBytes: number;
  requireHttps: boolean;
  now: () => number;
  logger: IngestLogger;
  /** Optional: skip scrypt for credentials that recently passed. */
  authCache?: VerifiedCredentialCache;
}

export const WWW_AUTHENTICATE = 'Basic realm="Foresite counter ingest", charset="UTF-8"';

/** A request without an `x-forwarded-proto` value of `https` is refused in production. */
function isHttps(request: Request): boolean {
  return firstForwardedValue(request.headers.get('x-forwarded-proto')) === 'https';
}

export async function handleCounterIngest(
  request: Request,
  provider: string,
  deps: IngestDeps,
): Promise<Response> {
  const started = deps.now();
  const requestId = randomUUID();
  const baseHeaders = { 'X-Request-Id': requestId };
  const log = (entry: Omit<IngestLogEntry, 'provider' | 'requestId' | 'durationMs'>) => {
    deps.logger({
      provider: getCounterAdapter(provider) ? provider : 'unknown',
      requestId,
      durationMs: deps.now() - started,
      ...entry,
    });
  };
  const fail = (
    status: number,
    error: string,
    extra: Partial<IngestLogEntry> = {},
    headers: Record<string, string> = {},
  ) => {
    log({ outcome: error, status, errorCode: error, ...extra });
    return jsonResponse(status, { error }, { ...baseHeaders, ...headers });
  };

  if (deps.requireHttps && !isHttps(request)) return fail(403, 'https_required');

  const adapter = getCounterAdapter(provider);
  if (adapter === undefined) return fail(404, 'unknown_provider');

  if (!isJsonContentType(request.headers.get('content-type'))) {
    return fail(415, 'unsupported_media_type');
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0) return fail(400, 'invalid_content_length');
    if (length > deps.maxBodyBytes) return fail(413, 'payload_too_large');
  }

  const repository = deps.repository;
  if (repository === null) return fail(503, 'storage_unavailable', {}, { 'Retry-After': '60' });

  // Slow down guessing before spending CPU on scrypt. The strict bucket is
  // per address and claimed device id; a malformed header gets a key of its
  // own. A credential that passed recently (in the verified cache) skips both
  // checks, so a good device is never locked out by its neighbours.
  const address = clientAddress(request.headers);
  const authorization = request.headers.get('authorization');
  const claimed = parseBasicAuth(authorization);
  const failureKey = `${address}|${claimed === null ? '#malformed' : claimed.deviceId}`;
  const cacheKey = claimed === null ? null : `${adapter.provider}:${claimed.deviceId}`;
  const trusted =
    claimed !== null &&
    cacheKey !== null &&
    deps.authCache?.recentlyVerified(cacheKey, claimed.secret) === true;
  if (!trusted) {
    const decisions = [await deps.authFailureLimiter.check(failureKey)];
    if (deps.authFailureAddressLimiter !== undefined) {
      decisions.push(await deps.authFailureAddressLimiter.check(address));
    }
    const denied = decisions.filter((d) => !d.allowed);
    if (denied.length > 0) {
      return fail(
        429,
        'rate_limited',
        { outcome: 'auth_throttled' },
        { 'Retry-After': String(Math.max(...denied.map((d) => d.retryAfterSeconds))) },
      );
    }
  }

  let auth;
  try {
    auth = await authenticateDevice(
      repository,
      adapter.provider,
      authorization,
      undefined,
      deps.authCache,
    );
  } catch {
    return fail(
      503,
      'storage_unavailable',
      { outcome: 'auth_lookup_failed' },
      { 'Retry-After': '60' },
    );
  }
  if (!auth.ok) {
    if (cacheKey !== null) deps.authCache?.forget(cacheKey);
    await deps.authFailureLimiter.take(failureKey);
    await deps.authFailureAddressLimiter?.take(address);
    return fail(
      401,
      'unauthorized',
      { outcome: `auth_${auth.reason}` },
      {
        'WWW-Authenticate': WWW_AUTHENTICATE,
      },
    );
  }
  const { device, slot } = auth;
  const who = { deviceId: device.deviceId, secretSlot: slot };

  const budget = await deps.deviceLimiter.take(`${adapter.provider}:${device.deviceId}`);
  if (!budget.allowed) {
    return fail(429, 'rate_limited', who, { 'Retry-After': String(budget.retryAfterSeconds) });
  }

  const body = await readBodyWithLimit(request, deps.maxBodyBytes);
  if (!body.ok) {
    // The client went away mid-body (review F7): a client problem, logged as a warning.
    if (body.reason === 'aborted') return fail(400, 'body_aborted', who);
    return fail(413, 'payload_too_large', who);
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes);
    parsed = JSON.parse(text);
  } catch {
    return fail(400, 'invalid_json', who);
  }
  // Too deep for recursive code, or strings jsonb cannot hold (review F4).
  const unsafe = checkJsonSafety(parsed);
  if (unsafe !== null)
    return fail(400, 'invalid_json', { ...who, outcome: `invalid_json_${unsafe}` });

  const receivedAtMs = deps.now();
  const receivedAt = new Date(receivedAtMs).toISOString();
  const payloadHash = hashPayload(body.bytes);
  const raw = (parseStatus: RawPayloadToStore['parseStatus'], errorCode: string | null) => ({
    venueId: device.venueId,
    deviceId: device.deviceId,
    provider: adapter.provider,
    payloadHash,
    payload: parsed,
    receivedAt,
    parseStatus,
    errorCode,
  });
  const event = (
    type: IngestEventToStore['type'],
    detail: IngestEventToStore['detail'],
  ): IngestEventToStore => ({
    venueId: device.venueId,
    deviceId: device.deviceId,
    type,
    occurredAt: receivedAt,
    detail,
  });

  // A throw from the adapter is a bug, not bad data: it surfaces as a 500 from the route.
  const mapped = adapter.map({ body: parsed, device, receivedAt, rawPayloadHash: payloadHash });

  try {
    if (!mapped.ok) {
      await repository.rejectPayload(
        raw('rejected', mapped.code),
        event('payload_rejected', { error_code: mapped.code, payload_hash: payloadHash }),
      );
      return fail(400, mapped.code, { ...who, paths: mapped.paths });
    }
    const result = mapped.value;

    if (
      device.vendorSerial !== null &&
      result.vendorSerials.some((serial) => serial !== device.vendorSerial)
    ) {
      await repository.rejectPayload(
        raw('rejected', 'device_mismatch'),
        event('device_mismatch', { payload_hash: payloadHash }),
      );
      return fail(403, 'device_mismatch', who);
    }

    const toStore: ReadingToStore[] = [];
    const events: IngestEventToStore[] = [];
    let rejected = 0;
    let late = 0;
    for (const reading of result.readings) {
      const verdict = judgeReadingClock(reading, receivedAtMs, deps.clock);
      if (verdict.kind === 'reject') {
        rejected += 1;
        events.push(
          event('reading_rejected_clock', {
            reason: verdict.reason,
            entry_point_id: reading.entryPointId,
            interval_start: reading.intervalStart,
            interval_end: reading.intervalEnd,
          }),
        );
        continue;
      }
      if (verdict.flag === 'late') late += 1;
      toStore.push({ ...reading, flag: verdict.flag });
    }
    for (const deviceEvent of result.events) {
      if (deviceEvent.type === 'device_alarm')
        events.push(event('device_alarm', { ...deviceEvent.detail }));
    }
    const ignored = result.events.filter((e) => e.type === 'report_ignored').length;

    const countsOf = (outcomes: IngestBatchResult['outcomes']) => ({
      accepted: outcomes.filter((o) => o.kind === 'accepted').length,
      duplicate: outcomes.filter((o) => o.kind === 'duplicate').length,
      conflict: outcomes.filter((o) => o.kind === 'conflict').length,
      rejected,
      late,
      ignored,
    });
    const stored = await repository.ingest({
      raw: raw('mapped', null),
      readings: toStore,
      events,
      // Written in the same transaction as the readings.
      summary: (outcome) =>
        event('request', {
          ...countsOf(outcome.outcomes),
          raw_duplicate: !outcome.rawStored,
          secret_slot: slot,
          report_types: result.reportTypes.join(','),
          payload_hash: payloadHash,
        }),
    });
    const counts = countsOf(stored.outcomes);

    const status = counts.accepted > 0 ? 201 : 200;
    log({ ...who, outcome: 'stored', status, counts, reportTypes: result.reportTypes });
    return jsonResponse(status, { status: 'ok', ...counts }, baseHeaders);
  } catch {
    // Storage failed mid-request. Nothing partial is committed (one
    // transaction per batch); the device's retransmission will retry.
    return fail(
      503,
      'storage_unavailable',
      { ...who, outcome: 'store_failed' },
      { 'Retry-After': '60' },
    );
  }
}
