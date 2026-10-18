import { z } from 'zod';

/**
 * zod schemas for the Milesight VS13x (VS133/VS135) HTTP(S) push payload.
 *
 * Source: Milesight VS135 (cellular) user guide, "Communication Protocol",
 * sub-pages "Periodic Report" and "Trigger Report":
 *   https://www.milesight.com/products/docs/en/vs135-cellular/steps/vs1xx/vs13x/vs13x-periodic-report.html
 *   https://www.milesight.com/products/docs/en/vs135-cellular/steps/vs1xx/vs13x/vs13x-trigger-report.html
 * and the VS135-P user guide (Feb 2024), section 7 "Communication Protocol"
 * (7.1 to 7.4), which shows the same field names.
 *
 * Policy: strict on the fields we use (types, ranges, presence), lenient on
 * everything else. Unknown keys are accepted and dropped from the parsed value
 * (the raw body, minus network and SIM identifiers, is kept separately in the
 * staging table), so a firmware update
 * that adds fields does not break ingest.
 *
 * The documented examples are not valid JSON as printed (trailing commas,
 * curly quotes); the field names and shapes are what we rely on.
 */

/** Interval counts. Ten times the busiest venue we can imagine per interval. */
const COUNT_MAX = 100_000;
const count = z.number().int().min(0).max(COUNT_MAX);

/**
 * Line number. The product page documents up to 4 detection lines per device;
 * multi-device stitching may number lines differently (UNVERIFIED), so allow
 * a little headroom.
 */
const lineNumber = z.number().int().min(1).max(16);

/** Free-text vendor strings we keep short to bound memory and log size. */
const shortString = (max: number) => z.string().min(1).max(max);

export const deviceInfoSchema = z.object({
  /** Device serial number. The only device_info field we rely on. */
  device_sn: shortString(64),
  // Documented but unused: device_name, cus_device_id, cus_site_id,
  // running_time, firmware_version, hardware_version. device_mac and
  // ip_address are removed before storage (see minimise.ts).
});

export const timeInfoSchema = z.object({
  /** Periodic reports: interval start, local time with offset. */
  start_time: shortString(40).optional(),
  /** Periodic reports: interval end, local time with offset. */
  end_time: shortString(40).optional(),
  /** Trigger reports: event time, local time with offset. */
  time: shortString(40).optional(),
  // Documented but unused: time_zone (a display label that can disagree with
  // the offset, see the trigger example), enable_dst, dst_status.
});

/** One line in `line_periodic_data`: counts for the reporting interval. */
export const linePeriodicSchema = z.object({
  line: lineNumber,
  in: count,
  out: count,
  line_uuid: shortString(128).optional(),
  // Documented but unused: line_name, staff_in/out, children_in/out,
  // group_in/out, *_cart_in/out.
});

/** One line in `line_total_data`: cumulative counts since the last reset. */
export const lineTotalSchema = z.object({
  line: lineNumber,
  /**
   * "Capacity Counted" (API spec 3.4, `lineTotalData` bit1). We read it as the
   * device's current occupancy for the line. UNVERIFIED: the docs do not
   * define it beyond the name.
   */
  capacity_counted: z.number().int().min(-COUNT_MAX).max(COUNT_MAX).optional(),
});

export const occlusionSchema = z.object({
  /** Documented value: "occluded". Other values UNVERIFIED. */
  occlusion_status: shortString(32),
});

/** One report as pushed by the device. */
export const milesightReportSchema = z.object({
  device_info: deviceInfoSchema,
  time_info: timeInfoSchema,
  line_periodic_data: z.array(linePeriodicSchema).max(16).optional(),
  line_total_data: z.array(lineTotalSchema).max(16).optional(),
  line_trigger_data: z.array(z.unknown()).max(64).optional(),
  region_data: z.unknown().optional(),
  region_trigger_data: z.unknown().optional(),
  tof_occlusion_trigger: occlusionSchema.optional(),
});

export type MilesightReport = z.infer<typeof milesightReportSchema>;

/**
 * Whether the device ever sends several reports in one request is
 * UNVERIFIED (the docs show one object per push). We accept a single object
 * or an array of up to this many objects.
 */
export const MAX_REPORTS_PER_REQUEST = 100;
