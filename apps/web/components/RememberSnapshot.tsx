'use client';

import { useEffect } from 'react';
import { LAST_SNAPSHOT_KEY, type KpiSnapshot } from '@/lib/demo-data';

/**
 * Keeps the last numbers the dashboard showed on this device so the offline
 * page can show them with their "last updated" time. Stored in localStorage;
 * cleared by `forgetSnapshot()` (to be called on sign-out once auth lands).
 */
export function RememberSnapshot({ snapshot }: { snapshot: KpiSnapshot }) {
  useEffect(() => {
    try {
      window.localStorage.setItem(LAST_SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch {
      // Private mode or storage full: the offline page will say there are no saved numbers.
    }
  }, [snapshot]);
  return null;
}

export function forgetSnapshot(): void {
  try {
    window.localStorage.removeItem(LAST_SNAPSHOT_KEY);
  } catch {
    // Nothing to clear.
  }
}
