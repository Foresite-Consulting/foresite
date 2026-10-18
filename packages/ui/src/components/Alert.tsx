import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'role'> {
  severity?: AlertSeverity;
  /** Short heading in plain words, e.g. "Sync behind". */
  title: ReactNode;
  children?: ReactNode;
  /** Optional action, usually a Button. */
  action?: ReactNode;
}

const severityLabel: Record<AlertSeverity, string> = {
  info: 'Note',
  warning: 'Warning',
  critical: 'Urgent',
};

const severityStyle: Record<AlertSeverity, string> = {
  info: 'border-l-text-secondary',
  warning: 'border-l-forecast',
  critical: 'border-l-negative',
};

const severityIcon: Record<AlertSeverity, ReactNode> = {
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  critical: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
};

/**
 * A message the manager should read. Severity is shown by a word, an icon and a
 * coloured edge, never by colour alone. Critical alerts use `role="alert"` so
 * screen readers announce them at once; the others use `role="status"`.
 */
export function Alert({
  severity = 'info',
  title,
  children,
  action,
  className,
  ...rest
}: AlertProps) {
  const titleId = useId();
  const bodyId = useId();
  const hasBody = children !== undefined && children !== null;

  return (
    <div
      role={severity === 'critical' ? 'alert' : 'status'}
      aria-labelledby={titleId}
      aria-describedby={hasBody ? bodyId : undefined}
      className={cn(
        'flex gap-3 rounded-md border border-border border-l-4 bg-surface p-4 text-text-primary',
        severityStyle[severity],
        className,
      )}
      {...rest}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        width="24"
        height="24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 shrink-0"
      >
        {severityIcon[severity]}
      </svg>
      <div className="min-w-0 flex-1">
        <p id={titleId} className="text-body font-semibold leading-snug">
          <span className="font-mono text-label uppercase tracking-wide text-text-secondary">
            {severityLabel[severity]}
          </span>
          <span className="sr-only">: </span>
          <span className="block">{title}</span>
        </p>
        {hasBody && (
          <div id={bodyId} className="mt-1 text-body text-text-secondary">
            {children}
          </div>
        )}
        {action !== undefined && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}
