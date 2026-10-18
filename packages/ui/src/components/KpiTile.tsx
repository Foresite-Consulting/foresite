import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

export type ChangeDirection = 'up' | 'down' | 'flat';
export type ChangeSentiment = 'positive' | 'negative' | 'neutral';

export interface KpiChange {
  direction: ChangeDirection;
  /** The size of the change, already formatted: "4.2%" or "$1,200". */
  amount: string;
  /** What it is compared with: "vs budget", "vs same day last year". */
  comparison: string;
  /**
   * Whether the change is good news. Defaults from the direction (up is good),
   * but labour cost going up is bad, so callers can say so.
   */
  sentiment?: ChangeSentiment;
}

export interface KpiForecastRange {
  /** Formatted low estimate: "$11,800". */
  low: string;
  /** Formatted high estimate: "$13,200". */
  high: string;
}

export interface KpiTileProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** What the number is, in plain words: "Revenue today". */
  label: string;
  /** The number, already formatted with its units and GST basis. */
  value: string;
  change?: KpiChange;
  /** Shown as "Likely range low–high". Use for forecast tiles. */
  forecastRange?: KpiForecastRange;
  /** Small print under the value, e.g. "Trading day to 2:05 pm". */
  footnote?: ReactNode;
}

const directionWord: Record<ChangeDirection, string> = {
  up: 'Up',
  down: 'Down',
  flat: 'No change',
};

const defaultSentiment: Record<ChangeDirection, ChangeSentiment> = {
  up: 'positive',
  down: 'negative',
  flat: 'neutral',
};

// Indicator colours meet 3:1 (graphics); the words beside them use text colours.
const sentimentColour: Record<ChangeSentiment, string> = {
  positive: 'text-positive',
  negative: 'text-negative',
  neutral: 'text-text-secondary',
};

function DirectionIcon({ direction }: { direction: ChangeDirection }) {
  const path =
    direction === 'up'
      ? 'M12 19V5m0 0-6 6m6-6 6 6'
      : direction === 'down'
        ? 'M12 5v14m0 0 6-6m-6 6-6-6'
        : 'M5 12h14';
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d={path} />
    </svg>
  );
}

/**
 * The number a manager needs, its change against a comparison, and (for
 * forecasts) the likely range. Direction is given by an icon and a word, so it
 * reads the same in greyscale and to a screen reader.
 */
export function KpiTile({
  label,
  value,
  change,
  forecastRange,
  footnote,
  className,
  ...rest
}: KpiTileProps) {
  const labelId = useId();
  const sentiment = change ? (change.sentiment ?? defaultSentiment[change.direction]) : 'neutral';

  return (
    <article
      aria-labelledby={labelId}
      className={cn(
        'flex flex-col gap-2 rounded-tile border border-border bg-surface p-4 text-text-primary shadow-sm sm:p-5',
        className,
      )}
      {...rest}
    >
      <h3 id={labelId} className="font-mono text-label uppercase tracking-wide text-text-secondary">
        {label}
      </h3>
      <p className="text-subheading font-semibold leading-none tabular-nums tracking-tight">
        {value}
      </p>
      {change && (
        <p className="flex items-center gap-1.5 text-body text-text-secondary">
          <span className={cn('inline-flex', sentimentColour[sentiment])}>
            <DirectionIcon direction={change.direction} />
          </span>
          <span>
            <span className="font-medium text-text-primary">
              {directionWord[change.direction]}
              {change.direction !== 'flat' && ` ${change.amount}`}
            </span>{' '}
            {change.comparison}
          </span>
        </p>
      )}
      {forecastRange && (
        <p className="text-body text-text-secondary">
          Likely range{' '}
          <span className="tabular-nums text-text-primary">
            {forecastRange.low}–{forecastRange.high}
          </span>
        </p>
      )}
      {footnote !== undefined && footnote !== null && (
        <p className="mt-auto pt-1 font-mono text-label text-text-secondary">{footnote}</p>
      )}
    </article>
  );
}
