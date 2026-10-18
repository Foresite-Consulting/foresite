/**
 * Harbourside Test Venue: the fictional venue the synthetic generator
 * models. It is not based on any real venue.
 */
import type { DateException, Session, VenueConfig } from '../venue/schema';
import { weekdayOf, type TradingDay, type Weekday } from '../time/dates';
import type { PublicHoliday } from './holidays';

export const SYNTHETIC_VENUE_ID = 'harbourside-test-venue';
export const SYNTHETIC_VENUE_NAME = 'Harbourside Test Venue';

/** The generator's sections. */
export const SYNTHETIC_SECTION_IDS = ['bar', 'restaurant', 'deck', 'functions'] as const;
export type SyntheticSectionId = (typeof SYNTHETIC_SECTION_IDS)[number];

const s = (open: string, close: string) => ({ open, close });

const WEEKLY_HOURS: Readonly<
  Record<SyntheticSectionId, Readonly<Record<Weekday, readonly Session[]>>>
> = {
  bar: {
    mon: [s('11:00', '23:00')],
    tue: [s('11:00', '23:00')],
    wed: [s('11:00', '23:00')],
    thu: [s('11:00', '23:00')],
    fri: [s('11:00', '02:00')],
    sat: [s('11:00', '02:00')],
    sun: [s('11:00', '22:00')],
  },
  restaurant: {
    mon: [],
    tue: [s('12:00', '15:00'), s('17:30', '21:30')],
    wed: [s('12:00', '15:00'), s('17:30', '21:30')],
    thu: [s('12:00', '15:00'), s('17:30', '21:30')],
    fri: [s('12:00', '15:00'), s('17:30', '22:00')],
    sat: [s('12:00', '15:00'), s('17:30', '22:00')],
    sun: [s('12:00', '15:00'), s('17:30', '21:00')],
  },
  deck: {
    mon: [],
    tue: [],
    wed: [s('12:00', '21:00')],
    thu: [s('12:00', '21:00')],
    fri: [s('12:00', '22:00')],
    sat: [s('12:00', '22:00')],
    sun: [s('12:00', '21:00')],
  },
  functions: {
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [s('18:00', '00:00')],
    sat: [s('18:00', '00:00')],
    sun: [],
  },
};

/** An entry point with a people counter. */
export interface SyntheticEntryPoint {
  readonly id: string;
  readonly name: string;
  /** Section the counter belongs to, or `null` for the whole venue. */
  readonly sectionId: SyntheticSectionId | null;
  /** Sections whose guests pass through it, and the share of their covers that do. */
  readonly feeds: Readonly<Partial<Record<SyntheticSectionId, number>>>;
}

export const SYNTHETIC_ENTRY_POINTS: readonly SyntheticEntryPoint[] = [
  {
    id: 'main-entrance',
    name: 'Main entrance',
    sectionId: null,
    feeds: { bar: 0.55, restaurant: 0.9, deck: 0.35, functions: 0.9 },
  },
  { id: 'deck-gate', name: 'Deck gate', sectionId: 'deck', feeds: { deck: 0.4 } },
];

/**
 * Venue configuration for Harbourside Test Venue.
 *
 * Calendar rules (all made up): closed on Christmas Day; other public
 * holidays trade Sunday hours, functions closed; New Year's Eve has late
 * special hours.
 */
export function syntheticVenueConfig(options: {
  timeZone: string;
  publicHolidays: readonly PublicHoliday[];
  firstDay: TradingDay;
  lastDay: TradingDay;
}): VenueConfig {
  const { firstDay, lastDay } = options;
  const inRange = (day: TradingDay): boolean => day >= firstDay && day <= lastDay;
  const exceptions = new Map<TradingDay, DateException>();
  for (const holiday of options.publicHolidays) {
    if (!inRange(holiday.date)) continue;
    exceptions.set(holiday.date, {
      kind: 'public_holiday',
      date: holiday.date,
      name: holiday.name,
      hours: {
        bar: WEEKLY_HOURS.bar.sun,
        restaurant: WEEKLY_HOURS.restaurant.sun,
        deck: WEEKLY_HOURS.deck.sun,
        functions: [],
      },
    });
  }
  const firstYear = Number(firstDay.slice(0, 4));
  const lastYear = Number(lastDay.slice(0, 4));
  for (let year = firstYear; year <= lastYear; year += 1) {
    const christmas = `${year}-12-25`;
    if (inRange(christmas)) {
      exceptions.set(christmas, {
        kind: 'closure',
        date: christmas,
        name: 'Christmas Day (closed)',
      });
    }
    const nye = `${year}-12-31`;
    if (inRange(nye)) {
      exceptions.set(nye, {
        kind: 'special_hours',
        date: nye,
        name: "New Year's Eve",
        hours: {
          bar: [s('11:00', '02:00')],
          deck: [s('12:00', '00:30')],
          functions: [s('19:00', '01:00')],
          // The restaurant keeps its normal hours for the weekday.
          restaurant: WEEKLY_HOURS.restaurant[weekdayOf(nye)],
        },
      });
    }
  }
  return {
    id: SYNTHETIC_VENUE_ID,
    name: SYNTHETIC_VENUE_NAME,
    timeZone: options.timeZone,
    cutOver: '05:00',
    sections: [
      { id: 'bar', name: 'Bar', hours: WEEKLY_HOURS.bar },
      { id: 'restaurant', name: 'Restaurant', hours: WEEKLY_HOURS.restaurant },
      { id: 'deck', name: 'Deck', hours: WEEKLY_HOURS.deck },
      { id: 'functions', name: 'Functions', hours: WEEKLY_HOURS.functions },
    ],
    exceptions: [...exceptions.values()],
  };
}
