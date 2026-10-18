'use client';

import { Alert, Button } from '@foresite/ui';
import { formatDateTime, formatTimeZoneAbbreviation } from '@foresite/ui/format';
import { useEffect, useState } from 'react';
import { SnapshotTiles } from '@/components/SnapshotTiles';
import type { KpiSnapshot } from '@/lib/demo-data';
import { readSnapshot } from '@/lib/snapshot-storage';

type State =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; snapshot: KpiSnapshot };

function readStoredSnapshot(): KpiSnapshot | null {
  try {
    return readSnapshot(window.localStorage);
  } catch {
    // window.localStorage itself can throw when storage is blocked.
    return null;
  }
}

export function OfflineView() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const snapshot = readStoredSnapshot();
    setState(snapshot ? { status: 'ready', snapshot } : { status: 'empty' });
  }, []);

  const retry = (
    <Button
      variant="secondary"
      onClick={() => {
        window.location.assign('/');
      }}
    >
      Try again
    </Button>
  );

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-subheading font-semibold leading-tight tracking-tight sm:text-heading">
        You&apos;re offline
      </h1>

      {state.status === 'loading' && (
        <p className="text-body text-text-secondary" aria-live="polite">
          Checking for saved numbers…
        </p>
      )}

      {state.status === 'empty' && (
        <Alert severity="warning" title="No saved numbers on this device yet" action={retry}>
          Open the dashboard once while connected and it will keep the last numbers here.
        </Alert>
      )}

      {state.status === 'ready' && (
        <>
          <Alert severity="warning" title="Showing the last numbers we had" action={retry}>
            Last updated{' '}
            <time dateTime={state.snapshot.updatedAt}>
              {formatDateTime(state.snapshot.updatedAt, { timeZone: state.snapshot.timeZone })}{' '}
              {formatTimeZoneAbbreviation(state.snapshot.updatedAt, {
                timeZone: state.snapshot.timeZone,
              })}
            </time>
            . They will refresh when the connection is back.
          </Alert>
          <SnapshotTiles
            snapshot={state.snapshot}
            footnote={state.snapshot.source === 'demo' ? 'Demo data · saved copy' : 'Saved copy'}
          />
        </>
      )}
    </div>
  );
}
