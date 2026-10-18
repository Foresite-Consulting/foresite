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

function audFormatter(cents: boolean): Intl.NumberFormat {
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency: 'AUD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
    // Intl rounds half away from zero (halfExpand) on the number's shortest
    // decimal form, so 1.005 → $1.01 and -2.675 → -$2.68. 'negative' drops the
    // sign when the rounded amount is zero, so -0.001 is "$0.00", never "-$0.00".
    signDisplay: 'negative',
  });
}

function withGst(amount: string, options: { gst: GstBasis; label?: boolean }): string {
  return (options.label ?? true) ? `${amount} ${gstLabel(options.gst)}` : amount;
}

/**
 * Format an amount in Australian dollars, for display.
 *
 * Money should flow through the app as **integer cents** (the data layer stores
 * it that way) and be shown with `formatAudCents`. Use `formatAud` for amounts
 * that are already dollars, such as a rounded forecast or a budget figure. It
 * rounds half away from zero; it is a display helper, not arithmetic.
 *
 * `formatAud(1234.5, { gst: 'ex' })` → `$1,234.50 ex GST`
 * `formatAud(-80, { gst: 'inc', cents: false })` → `-$80 inc GST`
 */
export function formatAud(value: number, options: AudOptions): string {
  assertFinite(value, 'value');
  // No pre-rounding here: Math.round(value * 100) / 100 mis-rounds half cents
  // (1.005 * 100 is 100.49999…). Intl rounds the decimal value correctly.
  return withGst(audFormatter(options.cents ?? true).format(value), options);
}

/**
 * Format an integer number of cents exactly: `formatAudCents(123450, { gst: 'ex' })`
 * → `$1,234.50 ex GST`. Throws `RangeError` for anything that is not a safe
 * integer, so a float that should have been rounded upstream is caught.
 * With `cents: false` the amount is rounded to whole dollars, half away from zero.
 */
export function formatAudCents(cents: number, options: AudOptions): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`cents must be a safe integer, got ${cents}`);
  }
  const showCents = options.cents ?? true;
  // Build the exact decimal string (no float division), then let Intl format
  // it. Intl accepts decimal strings (ES2023 Intl.NumberFormat v3, in Node 22
  // and every supported browser), so large amounts never lose a cent.
  const abs = Math.abs(cents);
  const sign = cents < 0 ? '-' : '';
  const decimal =
    `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}` as `${number}`;
  return withGst(audFormatter(showCents).format(decimal), options);
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
    // Intl rounds half away from zero on the decimal value (no pre-rounding,
    // which mis-rounds halves). 'exceptZero' and 'negative' both drop the sign
    // when the rounded value is zero, so there is never a "-0.0%".
    signDisplay: options.signed ? 'exceptZero' : 'negative',
  });
  return formatter.format(fraction);
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
