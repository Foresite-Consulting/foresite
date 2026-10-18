/**
 * Public holidays for the synthetic generator.
 *
 * The generator takes the list as input. Client builds load the real list
 * for the venue's state from an authoritative source (and keep it as venue
 * data); this repo only carries a sample.
 */
import type { TradingDay } from '../time/dates';

export interface PublicHoliday {
  readonly date: TradingDay;
  readonly name: string;
}

/**
 * SAMPLE DATA, for tests and synthetic data only. Western Australian public
 * holidays, Dec 2024 to Dec 2026, written from general knowledge.
 * `UNVERIFIED` against the WA Government gazette: do not use for a real
 * venue's calendar or for wages.
 */
export const SAMPLE_WA_PUBLIC_HOLIDAYS: readonly PublicHoliday[] = Object.freeze([
  { date: '2024-12-25', name: 'Christmas Day' },
  { date: '2024-12-26', name: 'Boxing Day' },
  { date: '2025-01-01', name: "New Year's Day" },
  { date: '2025-01-27', name: 'Australia Day (observed)' },
  { date: '2025-03-03', name: 'Labour Day' },
  { date: '2025-04-18', name: 'Good Friday' },
  { date: '2025-04-20', name: 'Easter Sunday' },
  { date: '2025-04-21', name: 'Easter Monday' },
  { date: '2025-04-25', name: 'Anzac Day' },
  { date: '2025-06-02', name: 'Western Australia Day' },
  { date: '2025-09-29', name: "King's Birthday" },
  { date: '2025-12-25', name: 'Christmas Day' },
  { date: '2025-12-26', name: 'Boxing Day' },
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-01-26', name: 'Australia Day' },
  { date: '2026-03-02', name: 'Labour Day' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-05', name: 'Easter Sunday' },
  { date: '2026-04-06', name: 'Easter Monday' },
  { date: '2026-04-25', name: 'Anzac Day' },
  { date: '2026-04-27', name: 'Anzac Day (additional day)' },
  { date: '2026-06-01', name: 'Western Australia Day' },
  { date: '2026-09-28', name: "King's Birthday" },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: 'Boxing Day' },
  { date: '2026-12-28', name: 'Boxing Day (additional day)' },
]);
