import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export interface BuiltByCreditProps extends HTMLAttributes<HTMLParagraphElement> {
  /** The credit line from the theme. Default: "Built by Foresite". */
  credit?: string;
}

/**
 * The only Foresite mark allowed in a client app: a small credit in the footer
 * or settings. Text only, so it never competes with the client's brand.
 */
export function BuiltByCredit({
  credit = 'Built by Foresite',
  className,
  ...rest
}: BuiltByCreditProps) {
  return (
    <p
      className={cn('font-mono text-label uppercase tracking-wide text-text-secondary', className)}
      {...rest}
    >
      {credit}
    </p>
  );
}
