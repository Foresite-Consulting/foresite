import { describe, expect, it } from 'vitest';
import { SNAPSHOT_LIMITS, demoSnapshot, isKpiSnapshot } from './demo-data';

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

  const base = () => JSON.parse(JSON.stringify(demoSnapshot())) as Record<string, unknown>;
  const tile = { id: 't', label: 'Label', value: '$1' };

  it('accepts up to 24 tiles and rejects more', () => {
    expect(isKpiSnapshot({ ...base(), tiles: Array.from({ length: 24 }, () => tile) })).toBe(true);
    expect(isKpiSnapshot({ ...base(), tiles: Array.from({ length: 25 }, () => tile) })).toBe(false);
    expect(SNAPSHOT_LIMITS.maxTiles).toBe(24);
  });

  it('rejects strings over 200 characters anywhere in the snapshot', () => {
    const long = 'x'.repeat(201);
    const ok = 'x'.repeat(200);
    expect(isKpiSnapshot({ ...base(), tiles: [{ ...tile, label: ok }] })).toBe(true);
    for (const bad of [
      { ...base(), tiles: [{ ...tile, id: long }] },
      { ...base(), tiles: [{ ...tile, label: long }] },
      { ...base(), tiles: [{ ...tile, value: long }] },
      {
        ...base(),
        tiles: [{ ...tile, change: { direction: 'up', amount: long, comparison: 'vs budget' } }],
      },
      { ...base(), tiles: [{ ...tile, forecastRange: { low: '$1', high: long } }] },
      { ...base(), timeZone: long },
    ]) {
      expect(isKpiSnapshot(bad)).toBe(false);
    }
  });

  it('checks nested change and range shapes, the date and the timezone', () => {
    expect(
      isKpiSnapshot({ ...base(), tiles: [{ ...tile, change: { direction: 'sideways' } }] }),
    ).toBe(false);
    expect(
      isKpiSnapshot({
        ...base(),
        tiles: [
          { ...tile, change: { direction: 'up', amount: '1', comparison: 'x', sentiment: 'meh' } },
        ],
      }),
    ).toBe(false);
    expect(isKpiSnapshot({ ...base(), tiles: [{ ...tile, forecastRange: { low: 1 } }] })).toBe(
      false,
    );
    expect(isKpiSnapshot({ ...base(), updatedAt: 'yesterday-ish' })).toBe(false);
    expect(isKpiSnapshot({ ...base(), timeZone: 'Mars/Olympus_Mons' })).toBe(false);
    expect(isKpiSnapshot({ ...base(), tiles: {} })).toBe(false);
    expect(isKpiSnapshot([])).toBe(false);
  });

  it('rejects unknown keys at every level', () => {
    const change = {
      direction: 'up',
      amount: '1%',
      comparison: 'vs budget',
      sentiment: 'positive',
    };
    const forecastRange = { low: '$1', high: '$2' };
    const full = { ...tile, change, forecastRange };
    expect(isKpiSnapshot({ ...base(), tiles: [full] })).toBe(true);
    for (const bad of [
      { ...base(), extra: true },
      { ...base(), tiles: [{ ...full, extra: true }] },
      { ...base(), tiles: [{ ...full, change: { ...change, extra: true } }] },
      { ...base(), tiles: [{ ...full, forecastRange: { ...forecastRange, extra: true } }] },
      // An inherited-looking key set as own data is still unknown.
      JSON.parse(
        `{"updatedAt":"2026-10-18T00:00:00Z","timeZone":"UTC","source":"demo","tiles":[],"__proto__":{"x":1}}`,
      ) as unknown,
    ]) {
      expect(isKpiSnapshot(bad)).toBe(false);
    }
  });
});
