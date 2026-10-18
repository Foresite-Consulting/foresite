import { Alert } from '@foresite/ui';
import { formatDateTime, formatTimeZoneAbbreviation } from '@foresite/ui/format';
import { AppShell } from '@/components/AppShell';
import { RememberSnapshot } from '@/components/RememberSnapshot';
import { SnapshotTiles } from '@/components/SnapshotTiles';
import { demoSnapshot } from '@/lib/demo-data';
import { getTheme } from '@/lib/theme';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const theme = getTheme();
  const snapshot = demoSnapshot(new Date());
  const updated = `${formatDateTime(snapshot.updatedAt, { timeZone: snapshot.timeZone })} ${formatTimeZoneAbbreviation(snapshot.updatedAt, { timeZone: snapshot.timeZone })}`;

  return (
    <AppShell theme={theme}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div>
            <h1 className="text-subheading font-semibold leading-tight tracking-tight sm:text-heading">
              Today
            </h1>
            <p className="mt-1 text-body text-text-secondary">
              Last updated <time dateTime={snapshot.updatedAt}>{updated}</time>
            </p>
          </div>
          <p className="rounded-full border border-border bg-surface px-3 py-1 font-mono text-label uppercase tracking-wide text-text-secondary">
            Demo data
          </p>
        </div>

        <Alert title="These numbers are made up">
          This is the Foresite app shell with demo data. A client build connects the venue&apos;s
          own systems and shows real trading here.
        </Alert>

        <section aria-labelledby="kpis-heading" className="flex flex-col gap-3">
          <h2 id="kpis-heading" className="sr-only">
            Key numbers
          </h2>
          <SnapshotTiles snapshot={snapshot} footnote="Demo data" />
        </section>

        <p className="text-body text-text-secondary">
          Forecasts are estimates, never guarantees. Each one shows its likely range and, once a
          venue is connected, its accuracy to date.
        </p>
      </div>
      <RememberSnapshot snapshot={snapshot} />
    </AppShell>
  );
}
