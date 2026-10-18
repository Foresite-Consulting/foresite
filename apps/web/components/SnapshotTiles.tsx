import { KpiTile } from '@foresite/ui';
import type { KpiSnapshot } from '@/lib/demo-data';

/** The KPI grid: one column on a phone, two on a tablet, three on a desktop. */
export function SnapshotTiles({
  snapshot,
  footnote,
}: {
  snapshot: KpiSnapshot;
  footnote?: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:gap-4">
      {snapshot.tiles.map((tile) => (
        <KpiTile
          key={tile.id}
          label={tile.label}
          value={tile.value}
          change={tile.change}
          forecastRange={tile.forecastRange}
          footnote={footnote}
        />
      ))}
    </div>
  );
}
