'use client';

import { useEffect } from 'react';
import type { KpiSnapshot } from '@/lib/demo-data';
import { forgetSnapshot as forget, saveSnapshot } from '@/lib/snapshot-storage';

/**
 * Keeps the last numbers the dashboard showed on this device so the offline
 * page can show them with their "last updated" time. Stored in localStorage.
 *
 * Only demo snapshots are kept (see `mayPersistSnapshot`): whether live
 * trading figures may stay on a device, and for how long, is for the auth PR
 * to decide, along with clearing them on sign-out via `forgetSnapshot()`.
 */
export function RememberSnapshot({ snapshot }: { snapshot: KpiSnapshot }) {
  useEffect(() => {
    try {
      saveSnapshot(window.localStorage, snapshot);
    } catch {
      // window.localStorage itself can throw when storage is blocked.
    }
  }, [snapshot]);
  return null;
}

export function forgetSnapshot(): void {
  try {
    forget(window.localStorage);
  } catch {
    // Storage blocked: nothing to clear.
  }
}
