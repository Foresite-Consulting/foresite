'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker in production builds only. In development the
 * worker would cache stale chunks and fight Fast Refresh.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      console.warn('Service worker registration failed', error);
    });
  }, []);
  return null;
}
