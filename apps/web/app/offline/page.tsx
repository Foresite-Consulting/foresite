import type { Metadata } from 'next';
import { AppShell } from '@/components/AppShell';
import { OfflineView } from '@/components/OfflineView';
import { getTheme } from '@/lib/theme';

export const metadata: Metadata = { title: 'Offline' };

/**
 * Served by the service worker when the network is down. The page itself is
 * cached at install; the numbers come from this device's last snapshot.
 */
export default function OfflinePage() {
  return (
    <AppShell theme={getTheme()}>
      <OfflineView />
    </AppShell>
  );
}
