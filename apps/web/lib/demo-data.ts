import { formatAud, formatCount, formatPercent } from '@foresite/ui/format';
import type { KpiChange, KpiForecastRange } from '@foresite/ui';

/**
 * Demo numbers for the dashboard shell. Entirely made up; not from any venue.
 * Every tile that shows them is labelled "Demo data".
 */
export interface KpiSnapshotTile {
  id: string;
  label: string;
  value: string;
  change?: KpiChange;
  forecastRange?: KpiForecastRange;
}

export interface KpiSnapshot {
  /** ISO timestamp of when these numbers were produced. */
  updatedAt: string;
  /** IANA timezone the venue trades in. */
  timeZone: string;
  /** Demo numbers, or live numbers from the venue's systems. */
  source: 'demo' | 'live';
  tiles: KpiSnapshotTile[];
}

const DEMO = {
  revenueToday: 12480,
  revenueBudget: 11975,
  covers: 312,
  coversLastWeek: 330,
  spendPerHead: 40,
  spendPerHeadLastYear: 40,
  labourPct: 0.312,
  labourBudgetPct: 0.298,
  gpPct: 0.684,
  gpBudgetPct: 0.68,
  tonightExpected: 9400,
  tonightLow: 8600,
  tonightHigh: 10300,
} as const;

function pctChange(now: number, then: number): number {
  return then === 0 ? 0 : (now - then) / then;
}

export function demoSnapshot(now: Date = new Date(), timeZone = 'Australia/Perth'): KpiSnapshot {
  const revenueChange = pctChange(DEMO.revenueToday, DEMO.revenueBudget);
  const coversDiff = DEMO.covers - DEMO.coversLastWeek;
  const labourDiffPts = (DEMO.labourPct - DEMO.labourBudgetPct) * 100;
  const gpDiffPts = (DEMO.gpPct - DEMO.gpBudgetPct) * 100;

  return {
    updatedAt: now.toISOString(),
    timeZone,
    source: 'demo',
    tiles: [
      {
        id: 'revenue',
        label: 'Revenue today',
        value: formatAud(DEMO.revenueToday, { gst: 'ex', cents: false }),
        change: {
          direction: revenueChange > 0 ? 'up' : revenueChange < 0 ? 'down' : 'flat',
          amount: formatPercent(Math.abs(revenueChange)),
          comparison: 'vs budget',
        },
      },
      {
        id: 'covers',
        label: 'Covers',
        value: formatCount(DEMO.covers),
        change: {
          direction: coversDiff > 0 ? 'up' : coversDiff < 0 ? 'down' : 'flat',
          amount: formatCount(Math.abs(coversDiff)),
          comparison: 'vs last Saturday',
        },
      },
      {
        id: 'spend',
        label: 'Spend per head',
        value: formatAud(DEMO.spendPerHead, { gst: 'inc', cents: false }),
        change: {
          direction: 'flat',
          amount: '',
          comparison: 'vs same day last year',
        },
      },
      {
        id: 'labour',
        label: 'Labour',
        value: formatPercent(DEMO.labourPct),
        change: {
          direction: labourDiffPts > 0 ? 'up' : labourDiffPts < 0 ? 'down' : 'flat',
          amount: `${labourDiffPts.toFixed(1)} pts`,
          comparison: 'vs budget',
          // Labour going up costs money, so up is bad news here.
          sentiment: labourDiffPts > 0 ? 'negative' : labourDiffPts < 0 ? 'positive' : 'neutral',
        },
      },
      {
        id: 'gp',
        label: 'Gross profit',
        value: formatPercent(DEMO.gpPct),
        change: {
          direction: gpDiffPts > 0 ? 'up' : gpDiffPts < 0 ? 'down' : 'flat',
          amount: `${gpDiffPts.toFixed(1)} pts`,
          comparison: 'vs budget',
        },
      },
      {
        id: 'tonight',
        label: 'Expected revenue tonight',
        value: formatAud(DEMO.tonightExpected, { gst: 'ex', cents: false }),
        forecastRange: {
          low: formatAud(DEMO.tonightLow, { gst: 'ex', cents: false, label: false }),
          high: formatAud(DEMO.tonightHigh, { gst: 'ex', cents: false, label: false }),
        },
      },
    ],
  };
}

/** Browser storage key for the last snapshot the dashboard rendered. */
export const LAST_SNAPSHOT_KEY = 'foresite.lastSnapshot.v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTile(value: unknown): value is KpiSnapshotTile {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    typeof value.value === 'string'
  );
}

export function isKpiSnapshot(value: unknown): value is KpiSnapshot {
  return (
    isRecord(value) &&
    typeof value.updatedAt === 'string' &&
    typeof value.timeZone === 'string' &&
    (value.source === 'demo' || value.source === 'live') &&
    Array.isArray(value.tiles) &&
    value.tiles.every(isTile)
  );
}
