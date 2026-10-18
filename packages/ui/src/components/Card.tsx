import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

export type HeadingLevel = 2 | 3 | 4;

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Optional heading. When given, the card becomes a labelled `<section>`. */
  title?: ReactNode;
  /** Heading level for `title`. Default: 2. */
  headingLevel?: HeadingLevel;
  /** Small text at the top right, e.g. "Demo data" or "Updated 2:05 pm". */
  aside?: ReactNode;
  children: ReactNode;
}

/**
 * A surface that groups related content. Cards never carry colour of their own
 * beyond `surface` and `border`, so client themes stay in control.
 */
export function Card({ title, headingLevel = 2, aside, className, children, ...rest }: CardProps) {
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  const Tag = title !== undefined ? 'section' : 'div';

  return (
    <Tag
      aria-labelledby={title !== undefined ? headingId : undefined}
      className={cn(
        'rounded-tile border border-border bg-surface p-4 text-text-primary shadow-sm sm:p-5',
        className,
      )}
      {...rest}
    >
      {(title !== undefined || aside !== undefined) && (
        <header className="mb-3 flex items-baseline justify-between gap-3">
          {title !== undefined && (
            <Heading id={headingId} className="text-body font-semibold leading-tight">
              {title}
            </Heading>
          )}
          {aside !== undefined && (
            <div className="shrink-0 font-mono text-label uppercase text-text-secondary">
              {aside}
            </div>
          )}
        </header>
      )}
      {children}
    </Tag>
  );
}
