/**
 * Format helpers. Australian English, AUD with the GST basis stated, metric,
 * dates as `18 Oct 2026`, times in the venue's local timezone.
 *
 * Every helper is pure and relies only on `Intl`, which Node 22 and all
 * supported browsers ship with full ICU data.
 */

export const LOCALE = 'en-AU';
export const DEFAULT_TIME_ZONE = 'Australia/Perth';

export type GstBasis = 'ex' | 'inc';

export interface AudOptions {
  /** Whether the amount excludes or includes GST. Required so the basis is never implied. */
  gst: GstBasis;
  /** Show cents. Default: true. Use false for dashboard tiles. */
  cents?: boolean;
  /** Append " ex GST" / " inc GST". Default: true. */
  label?: boolean;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value))
    throw new RangeError(`${name} must be a finite number, got ${value}`);
}

/**
 * Format an amount in Australian dollars.
 *
 * `formatAud(1234.5, { gst: 'ex' })` → `$1,234.50 ex GST`
 * `formatAud(-80, { gst: 'inc', cents: false })` → `-$80 inc GST`
 */
export function formatAud(value: number, options: AudOptions): string {
  assertFinite(value, 'value');
  const cents = options.cents ?? true;
  const formatter = new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency: 'AUD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
  // Avoid "-$0" when a tiny negative rounds to zero.
  const rounded = cents ? Math.round(value * 100) / 100 : Math.round(value);
  const amount = formatter.format(rounded === 0 ? 0 : rounded);
  return (options.label ?? true) ? `${amount} ${gstLabel(options.gst)}` : amount;
}

export function gstLabel(gst: GstBasis): string {
  return gst === 'ex' ? 'ex GST' : 'inc GST';
}

export interface PercentOptions {
  /** Decimal places. Default: 1. */
  decimals?: number;
  /** Prefix positive values with "+", for changes. Default: false. */
  signed?: boolean;
}

/**
 * Format a ratio as a percentage. The input is a fraction: 0.042 → `4.2%`.
 */
export function formatPercent(fraction: number, options: PercentOptions = {}): string {
  assertFinite(fraction, 'fraction');
  const decimals = options.decimals ?? 1;
  const formatter = new Intl.NumberFormat(LOCALE, {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: options.signed ? 'exceptZero' : 'auto',
  });
  const factor = 10 ** (decimals + 2);
  const rounded = Math.round(fraction * factor) / factor;
  return formatter.format(rounded === 0 ? 0 : rounded);
}

/** Format a whole-number count with thousands separators: 12345 → `12,345`. */
export function formatCount(value: number): string {
  assertFinite(value, 'value');
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(value);
}

export interface DateOptions {
  /** IANA timezone of the venue. Default: Australia/Perth. */
  timeZone?: string;
}

function toDate(value: Date | number | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${String(value)}`);
  return date;
}

/** `18 Oct 2026`, in the venue's timezone. */
export function formatDate(value: Date | number | string, options: DateOptions = {}): string {
  const date = toDate(value);
  return new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
  }).format(date);
}

/** `2:05 pm`, in the venue's timezone. */
export function formatTime(value: Date | number | string, options: DateOptions = {}): string {
  const date = toDate(value);
  return new Intl.DateTimeFormat(LOCALE, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
  }).format(date);
}

/** `18 Oct 2026, 2:05 pm`, in the venue's timezone. */
export function formatDateTime(value: Date | number | string, options: DateOptions = {}): string {
  return `${formatDate(value, options)}, ${formatTime(value, options)}`;
}

/** Short timezone label such as `AWST` or `AEDT` for the instant given. */
export function formatTimeZoneAbbreviation(
  value: Date | number | string,
  options: DateOptions = {},
): string {
  const date = toDate(value);
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZoneName: 'short',
    timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
  }).formatToParts(date);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
}
