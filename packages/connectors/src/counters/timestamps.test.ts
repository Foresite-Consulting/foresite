import { describe, expect, it } from 'vitest';
import { parseOffsetTimestamp, toUtcIso } from './timestamps';

const iso = (value: string) => {
  const ms = parseOffsetTimestamp(value);
  return ms === null ? null : toUtcIso(ms);
};

describe('parseOffsetTimestamp', () => {
  it('converts local time with an offset to UTC', () => {
    expect(iso('2026-10-17T19:05:00+08:00')).toBe('2026-10-17T11:05:00.000Z');
    expect(iso('2024-05-30T14:28:11+10:00')).toBe('2024-05-30T04:28:11.000Z');
    expect(iso('2026-10-17T01:00:00-03:30')).toBe('2026-10-17T04:30:00.000Z');
    expect(iso('2026-10-17T11:05Z')).toBe('2026-10-17T11:05:00.000Z');
    expect(iso('2026-10-17T11:05:00.123456Z')).toBe('2026-10-17T11:05:00.123Z');
  });

  it('handles an interval that crosses midnight and a date line in UTC', () => {
    expect(iso('2026-10-18T00:05:00+08:00')).toBe('2026-10-17T16:05:00.000Z');
    expect(iso('2027-01-01T07:00:00+08:00')).toBe('2026-12-31T23:00:00.000Z');
  });

  it('rejects timestamps without an offset, because they are ambiguous', () => {
    expect(parseOffsetTimestamp('2026-10-17T19:05:00')).toBeNull();
    expect(parseOffsetTimestamp('2026-10-17 19:05:00+08:00')).toBeNull();
    expect(parseOffsetTimestamp('1760698800')).toBeNull();
  });

  it('rejects impossible calendar values instead of rolling them over', () => {
    expect(parseOffsetTimestamp('2026-02-29T00:00:00Z')).toBeNull();
    expect(parseOffsetTimestamp('2028-02-29T00:00:00Z')).not.toBeNull();
    expect(parseOffsetTimestamp('2026-13-01T00:00:00Z')).toBeNull();
    expect(parseOffsetTimestamp('2026-04-31T00:00:00Z')).toBeNull();
    expect(parseOffsetTimestamp('2026-10-17T24:00:00Z')).toBeNull();
    expect(parseOffsetTimestamp('2026-10-17T23:60:00Z')).toBeNull();
    expect(parseOffsetTimestamp('2026-10-17T23:00:60Z')).toBeNull();
    expect(parseOffsetTimestamp('2026-10-17T23:00:00+15:00')).toBeNull();
    expect(parseOffsetTimestamp('2026-10-17T23:00:00+08:60')).toBeNull();
  });
});
