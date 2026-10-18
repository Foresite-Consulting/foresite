import { describe, expect, it } from 'vitest';
import { LAST_SNAPSHOT_KEY, demoSnapshot, type KpiSnapshot } from './demo-data';
import {
  forgetSnapshot,
  mayPersistSnapshot,
  readSnapshot,
  saveSnapshot,
  type SnapshotStorage,
} from './snapshot-storage';

function memoryStorage(initial: Record<string, string> = {}): SnapshotStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

const throwing: SnapshotStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('quota');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('snapshot storage', () => {
  it('saves and reads back a demo snapshot', () => {
    const storage = memoryStorage();
    const snapshot = demoSnapshot(new Date('2026-10-18T06:05:00Z'));
    expect(saveSnapshot(storage, snapshot)).toBe(true);
    expect(readSnapshot(storage)).toEqual(snapshot);
  });

  it('does not keep live numbers on the device (until auth decides retention)', () => {
    const storage = memoryStorage();
    const live: KpiSnapshot = { ...demoSnapshot(), source: 'live' };
    expect(mayPersistSnapshot(live)).toBe(false);
    expect(saveSnapshot(storage, live)).toBe(false);
    expect(storage.data.has(LAST_SNAPSHOT_KEY)).toBe(false);
  });

  it('does not save a snapshot that would fail validation on the way back', () => {
    const storage = memoryStorage();
    const tooMany: KpiSnapshot = {
      ...demoSnapshot(),
      tiles: Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, label: 'L', value: 'V' })),
    };
    expect(saveSnapshot(storage, tooMany)).toBe(false);
    expect(storage.data.size).toBe(0);
  });

  it('ignores tampered, oversized or corrupt stored values', () => {
    expect(readSnapshot(memoryStorage({ [LAST_SNAPSHOT_KEY]: '{ not json' }))).toBeNull();
    expect(
      readSnapshot(memoryStorage({ [LAST_SNAPSHOT_KEY]: JSON.stringify({ tiles: 'x' }) })),
    ).toBeNull();
    const huge = JSON.stringify({ ...demoSnapshot(), padding: 'x'.repeat(70_000) });
    expect(readSnapshot(memoryStorage({ [LAST_SNAPSHOT_KEY]: huge }))).toBeNull();
    expect(readSnapshot(memoryStorage())).toBeNull();
  });

  it('never throws when storage is blocked or full', () => {
    expect(saveSnapshot(throwing, demoSnapshot())).toBe(false);
    expect(readSnapshot(throwing)).toBeNull();
    expect(() => {
      forgetSnapshot(throwing);
    }).not.toThrow();
  });

  it('forgets the snapshot', () => {
    const storage = memoryStorage();
    saveSnapshot(storage, demoSnapshot());
    forgetSnapshot(storage);
    expect(readSnapshot(storage)).toBeNull();
  });
});
