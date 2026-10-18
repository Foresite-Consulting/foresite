import { describe, expect, it } from 'vitest';
import { demoSnapshot, isKpiSnapshot } from './demo-data';

describe('demoSnapshot', () => {
  const snapshot = demoSnapshot(new Date('2026-10-18T06:05:00Z'));

  it('is labelled as demo and carries the time and timezone', () => {
    expect(snapshot.source).toBe('demo');
    expect(snapshot.updatedAt).toBe('2026-10-18T06:05:00.000Z');
    expect(snapshot.timeZone).toBe('Australia/Perth');
  });

  it('states the GST basis on every dollar figure', () => {
    for (const tile of snapshot.tiles) {
      if (tile.value.startsWith('$')) expect(tile.value).toMatch(/ (ex|inc) GST$/);
    }
  });

  it('has a forecast tile with a likely range and six tiles in all', () => {
    expect(snapshot.tiles).toHaveLength(6);
    const tonight = snapshot.tiles.find((t) => t.id === 'tonight');
    expect(tonight?.forecastRange).toEqual({ low: '$8,600', high: '$10,300' });
    expect(tonight?.label).toMatch(/^Expected/);
  });

  it('marks labour going up as bad news', () => {
    const labour = snapshot.tiles.find((t) => t.id === 'labour');
    expect(labour?.change?.direction).toBe('up');
    expect(labour?.change?.sentiment).toBe('negative');
  });
});

describe('isKpiSnapshot', () => {
  it('accepts a real snapshot and rejects junk', () => {
    expect(isKpiSnapshot(demoSnapshot())).toBe(true);
    expect(isKpiSnapshot(null)).toBe(false);
    expect(isKpiSnapshot({ updatedAt: 'x' })).toBe(false);
    expect(
      isKpiSnapshot({ updatedAt: 'x', timeZone: 'UTC', source: 'demo', tiles: [{ id: 1 }] }),
    ).toBe(false);
    expect(isKpiSnapshot(JSON.parse(JSON.stringify(demoSnapshot())))).toBe(true);
  });
});
