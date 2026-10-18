import { describe, expect, it } from 'vitest';
import {
  formatAud,
  formatCount,
  formatDate,
  formatDateTime,
  formatPercent,
  formatTime,
  formatTimeZoneAbbreviation,
} from './index';

describe('formatAud', () => {
  it('formats with cents and the GST basis', () => {
    expect(formatAud(1234.5, { gst: 'ex' })).toBe('$1,234.50 ex GST');
    expect(formatAud(1234.5, { gst: 'inc' })).toBe('$1,234.50 inc GST');
  });

  it('can drop cents for dashboard tiles', () => {
    expect(formatAud(12480.4, { gst: 'ex', cents: false })).toBe('$12,480 ex GST');
    expect(formatAud(12480.6, { gst: 'ex', cents: false })).toBe('$12,481 ex GST');
  });

  it('can drop the label when the basis is stated nearby', () => {
    expect(formatAud(99, { gst: 'inc', label: false })).toBe('$99.00');
  });

  it('handles negatives (refunds) with a leading minus', () => {
    expect(formatAud(-80, { gst: 'inc' })).toBe('-$80.00 inc GST');
    expect(formatAud(-1234.56, { gst: 'ex', cents: false })).toBe('-$1,235 ex GST');
  });

  it('never shows a negative zero', () => {
    expect(formatAud(-0.001, { gst: 'ex' })).toBe('$0.00 ex GST');
    expect(formatAud(-0.4, { gst: 'ex', cents: false })).toBe('$0 ex GST');
    expect(formatAud(0, { gst: 'inc' })).toBe('$0.00 inc GST');
  });

  it('handles large numbers', () => {
    expect(formatAud(12_345_678.9, { gst: 'ex' })).toBe('$12,345,678.90 ex GST');
    expect(formatAud(1e9, { gst: 'ex', cents: false })).toBe('$1,000,000,000 ex GST');
  });

  it('rounds half cents the way a till does', () => {
    expect(formatAud(0.005, { gst: 'ex', label: false })).toBe('$0.01');
    expect(formatAud(2.675, { gst: 'ex', label: false })).toBe('$2.68');
  });

  it('rejects NaN and infinity', () => {
    expect(() => formatAud(Number.NaN, { gst: 'ex' })).toThrow(RangeError);
    expect(() => formatAud(Number.POSITIVE_INFINITY, { gst: 'ex' })).toThrow(RangeError);
  });
});

describe('formatPercent', () => {
  it('formats a fraction with one decimal by default', () => {
    expect(formatPercent(0.042)).toBe('4.2%');
    expect(formatPercent(0.3)).toBe('30.0%');
    expect(formatPercent(1)).toBe('100.0%');
  });

  it('supports other precisions', () => {
    expect(formatPercent(0.04256, { decimals: 2 })).toBe('4.26%');
    expect(formatPercent(0.04256, { decimals: 0 })).toBe('4%');
  });

  it('shows a sign for changes', () => {
    expect(formatPercent(0.042, { signed: true })).toBe('+4.2%');
    expect(formatPercent(-0.042, { signed: true })).toBe('-4.2%');
    expect(formatPercent(0, { signed: true })).toBe('0.0%');
    expect(formatPercent(-0.0001, { signed: true })).toBe('0.0%');
  });

  it('handles negatives and large values', () => {
    expect(formatPercent(-0.5)).toBe('-50.0%');
    expect(formatPercent(12.345)).toBe('1,234.5%');
  });

  it('rejects NaN', () => {
    expect(() => formatPercent(Number.NaN)).toThrow(RangeError);
  });
});

describe('formatCount', () => {
  it('adds thousands separators and drops decimals', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(312)).toBe('312');
    expect(formatCount(12345.6)).toBe('12,346');
    expect(formatCount(-7)).toBe('-7');
  });
});

describe('dates and times', () => {
  // 16:30 UTC on 17 Oct is 00:30 on 18 Oct in Perth (AWST, UTC+8).
  const instant = new Date('2026-10-17T16:30:00Z');

  it('formats dates as 18 Oct 2026 in Perth by default', () => {
    expect(formatDate(instant)).toBe('18 Oct 2026');
  });

  it('respects the given timezone across the day boundary', () => {
    expect(formatDate(instant, { timeZone: 'UTC' })).toBe('17 Oct 2026');
    // Sydney is on daylight saving in October (AEDT, UTC+11).
    expect(formatDate(instant, { timeZone: 'Australia/Sydney' })).toBe('18 Oct 2026');
    expect(formatDate(new Date('2026-10-17T12:59:59Z'), { timeZone: 'Australia/Sydney' })).toBe(
      '17 Oct 2026',
    );
    expect(formatDate(new Date('2026-10-17T13:00:00Z'), { timeZone: 'Australia/Sydney' })).toBe(
      '18 Oct 2026',
    );
  });

  it('accepts ISO strings and epoch milliseconds', () => {
    expect(formatDate('2026-10-17T16:30:00Z')).toBe('18 Oct 2026');
    expect(formatDate(instant.getTime())).toBe('18 Oct 2026');
  });

  it('formats times in 12-hour form with am/pm', () => {
    expect(formatTime(new Date('2026-10-18T06:05:00Z'))).toBe('2:05 pm');
    expect(formatTime(new Date('2026-10-18T16:00:00Z'))).toBe('12:00 am');
    expect(formatTime(new Date('2026-10-18T04:00:00Z'))).toBe('12:00 pm');
  });

  it('combines date and time', () => {
    expect(formatDateTime(new Date('2026-10-18T06:05:00Z'))).toBe('18 Oct 2026, 2:05 pm');
  });

  it('names the timezone for the instant', () => {
    expect(formatTimeZoneAbbreviation(instant)).toBe('AWST');
    expect(formatTimeZoneAbbreviation(instant, { timeZone: 'Australia/Sydney' })).toBe('AEDT');
    expect(
      formatTimeZoneAbbreviation(new Date('2026-06-01T00:00:00Z'), {
        timeZone: 'Australia/Sydney',
      }),
    ).toBe('AEST');
  });

  it('rejects invalid dates', () => {
    expect(() => formatDate('not a date')).toThrow(RangeError);
  });
});
