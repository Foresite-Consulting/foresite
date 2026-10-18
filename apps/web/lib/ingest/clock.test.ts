import { describe, expect, it } from 'vitest';
import { DEFAULT_CLOCK_POLICY, judgeReadingClock } from './clock';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const minutes = (n: number) => n * 60_000;

function interval(endOffsetMs: number, lengthMs = minutes(5)) {
  const end = NOW + endOffsetMs;
  return {
    intervalStart: new Date(end - lengthMs).toISOString(),
    intervalEnd: new Date(end).toISOString(),
  };
}

describe('judgeReadingClock', () => {
  it('accepts a fresh interval without a flag', () => {
    expect(judgeReadingClock(interval(-minutes(1)), NOW, DEFAULT_CLOCK_POLICY)).toEqual({
      kind: 'ok',
      flag: null,
    });
  });

  it('tolerates small clock drift into the future', () => {
    expect(judgeReadingClock(interval(minutes(10)), NOW, DEFAULT_CLOCK_POLICY).kind).toBe('ok');
  });

  it('rejects intervals ending more than 10 minutes in the future', () => {
    expect(judgeReadingClock(interval(minutes(10) + 1), NOW, DEFAULT_CLOCK_POLICY)).toEqual({
      kind: 'reject',
      reason: 'future',
    });
  });

  it('flags buffered data as late but keeps it', () => {
    expect(judgeReadingClock(interval(-minutes(15)), NOW, DEFAULT_CLOCK_POLICY)).toEqual({
      kind: 'ok',
      flag: null,
    });
    expect(judgeReadingClock(interval(-minutes(16)), NOW, DEFAULT_CLOCK_POLICY)).toEqual({
      kind: 'ok',
      flag: 'late',
    });
    const twentyNineDays = -29 * 24 * minutes(60);
    expect(judgeReadingClock(interval(twentyNineDays), NOW, DEFAULT_CLOCK_POLICY)).toEqual({
      kind: 'ok',
      flag: 'late',
    });
  });

  it('rejects intervals that started more than 30 days ago', () => {
    const thirtyDays = 30 * 24 * minutes(60);
    expect(
      judgeReadingClock(interval(-thirtyDays + minutes(5)), NOW, DEFAULT_CLOCK_POLICY).kind,
    ).toBe('ok');
    expect(
      judgeReadingClock(interval(-thirtyDays + minutes(5) - 1), NOW, DEFAULT_CLOCK_POLICY),
    ).toEqual({ kind: 'reject', reason: 'too_old' });
  });

  it('follows a configured window', () => {
    const policy = { maxFutureMinutes: 1, maxAgeDays: 2, lateAfterMinutes: 60 };
    expect(judgeReadingClock(interval(minutes(2)), NOW, policy).kind).toBe('reject');
    expect(judgeReadingClock(interval(-minutes(30)), NOW, policy)).toEqual({
      kind: 'ok',
      flag: null,
    });
    expect(judgeReadingClock(interval(-3 * 24 * minutes(60)), NOW, policy).kind).toBe('reject');
  });
});
