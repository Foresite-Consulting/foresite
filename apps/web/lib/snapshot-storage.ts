import { LAST_SNAPSHOT_KEY, isKpiSnapshot, type KpiSnapshot } from './demo-data';

/** The part of `Storage` these helpers use, so tests can pass a fake. */
export type SnapshotStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Anything larger than this in storage is not ours (six demo tiles are ~2 KB). */
const MAX_STORED_LENGTH = 64 * 1024;

/**
 * Whether a snapshot may be kept on the device. Only demo numbers for now:
 * live trading figures (and anything wage-related) stay off the device until
 * the auth PR decides retention and clears the snapshot on sign-out.
 */
export function mayPersistSnapshot(snapshot: KpiSnapshot): boolean {
  return snapshot.source === 'demo';
}

/** Save the snapshot if allowed. Returns true if it was written. Never throws. */
export function saveSnapshot(storage: SnapshotStorage, snapshot: KpiSnapshot): boolean {
  if (!mayPersistSnapshot(snapshot) || !isKpiSnapshot(snapshot)) return false;
  try {
    storage.setItem(LAST_SNAPSHOT_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    // Private mode or storage full: the offline page will say there are no saved numbers.
    return false;
  }
}

/** Read back a stored snapshot, or null if there is none or it fails validation. Never throws. */
export function readSnapshot(storage: SnapshotStorage): KpiSnapshot | null {
  try {
    const raw = storage.getItem(LAST_SNAPSHOT_KEY);
    if (raw === null || raw.length > MAX_STORED_LENGTH) return null;
    const parsed: unknown = JSON.parse(raw);
    return isKpiSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Remove the stored snapshot (to be called on sign-out once auth lands). Never throws. */
export function forgetSnapshot(storage: SnapshotStorage): void {
  try {
    storage.removeItem(LAST_SNAPSHOT_KEY);
  } catch {
    // Nothing to clear.
  }
}
