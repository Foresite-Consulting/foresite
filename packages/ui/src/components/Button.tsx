import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Stretch to the container's width (phone layouts). */
  fullWidth?: boolean;
}

const base =
  'inline-flex min-h-tap min-w-tap items-center justify-center gap-2 rounded-md px-4 py-2 ' +
  'text-body font-semibold leading-none transition-colors ' +
  // Focus outline in the link colour, drawn outside the fill so it sits on bg or surface.
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const variants: Record<ButtonVariant, string> = {
  // Brand rule: the action colour carries on-action text, never white.
  primary: 'bg-action text-on-action hover:bg-action/90 active:bg-action/80',
  secondary: 'border border-border bg-surface text-text-primary hover:bg-bg active:bg-border/60',
  ghost: 'text-link underline decoration-1 underline-offset-4 hover:decoration-2',
};

/**
 * A button. `type` defaults to "button" so a stray click inside a form never
 * submits it by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', fullWidth = false, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(base, variants[variant], fullWidth && 'w-full', className)}
      {...rest}
    />
  );
});
