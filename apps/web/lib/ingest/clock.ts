import type { CounterReading } from '@foresite/connectors/counters';
import type { ReadingFlag } from './repository';

/**
 * Clock sanity for readings, judged against the time we received them.
 *
 * - Interval ends more than `maxFutureMinutes` after receipt: rejected. The
 *   device clock is wrong (no NTP, wrong timezone) and the data cannot be
 *   placed in time.
 * - Interval starts more than `maxAgeDays` before receipt: rejected. Older
 *   than any outage buffer we expect to replay.
 * - Interval ends more than `lateAfterMinutes` before receipt: stored and
 *   counted, flagged `late`. This is the normal case for data the device
 *   buffered during an outage and re-sent.
 *
 * Rejections are recorded as events and counted in the response, but the
 * request still succeeds so the device does not retry them forever.
 */

export interface ClockPolicy {
  maxFutureMinutes: number;
  maxAgeDays: number;
  lateAfterMinutes: number;
}

export const DEFAULT_CLOCK_POLICY: ClockPolicy = {
  maxFutureMinutes: 10,
  maxAgeDays: 30,
  lateAfterMinutes: 15,
};

export type ClockVerdict =
  | { kind: 'ok'; flag: ReadingFlag }
  | { kind: 'reject'; reason: 'future' | 'too_old' };

export function judgeReadingClock(
  reading: Pick<CounterReading, 'intervalStart' | 'intervalEnd'>,
  receivedAtMs: number,
  policy: ClockPolicy,
): ClockVerdict {
  const start = Date.parse(reading.intervalStart);
  const end = Date.parse(reading.intervalEnd);
  if (end - receivedAtMs > policy.maxFutureMinutes * 60_000) {
    return { kind: 'reject', reason: 'future' };
  }
  if (receivedAtMs - start > policy.maxAgeDays * 86_400_000) {
    return { kind: 'reject', reason: 'too_old' };
  }
  const late = receivedAtMs - end > policy.lateAfterMinutes * 60_000;
  return { kind: 'ok', flag: late ? 'late' : null };
}
