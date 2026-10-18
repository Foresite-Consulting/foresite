/**
 * Shared fixtures for the unit tests: fictional venues only.
 * Not exported from the package.
 */
import { parseVenue, type Venue, type VenueConfig } from './venue/schema';

export const BAR_HOURS: NonNullable<VenueConfig['sections'][number]['hours']> = {
  mon: [{ open: '11:00', close: '23:00' }],
  tue: [{ open: '11:00', close: '23:00' }],
  wed: [{ open: '11:00', close: '23:00' }],
  thu: [{ open: '11:00', close: '23:00' }],
  fri: [{ open: '11:00', close: '02:00' }],
  sat: [{ open: '11:00', close: '02:00' }],
  sun: [{ open: '11:00', close: '22:00' }],
};

const TWO_SESSIONS = [
  { open: '12:00', close: '15:00' },
  { open: '17:30', close: '22:00' },
];

export const RESTAURANT_HOURS = {
  tue: TWO_SESSIONS,
  wed: TWO_SESSIONS,
  thu: TWO_SESSIONS,
  fri: TWO_SESSIONS,
  sat: TWO_SESSIONS,
  sun: TWO_SESSIONS,
};

/** A fictional two-section venue; override any field. */
export function testVenueConfig(overrides: Partial<VenueConfig> = {}): VenueConfig {
  return {
    id: 'unit-test-venue',
    name: 'Unit Test Venue',
    sections: [
      { id: 'bar', name: 'Bar', hours: BAR_HOURS },
      { id: 'restaurant', name: 'Restaurant', hours: RESTAURANT_HOURS },
    ],
    ...overrides,
  };
}

export function testVenue(overrides: Partial<VenueConfig> = {}): Venue {
  return parseVenue(testVenueConfig(overrides));
}
