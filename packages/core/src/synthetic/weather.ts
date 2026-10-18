/**
 * A synthetic daily weather series (made up, loosely Perth-like): a
 * Southern Hemisphere seasonal cycle with day-to-day persistence and winter
 * rain. Integers only: tenths of a degree and tenths of a millimetre.
 */
import { addDays, parseTradingDay, type TradingDay } from '../time/dates';
import { Rng } from './prng';

export interface SyntheticWeatherDay {
  readonly trading_day: TradingDay;
  /** Daily maximum temperature, tenths of °C (e.g. 284 = 28.4 °C). */
  readonly max_temp_tenths_c: number;
  /** Rainfall, tenths of a millimetre. */
  readonly rain_tenths_mm: number;
}

const TAU = 2 * Math.PI;

/** Fraction of the year, 0 at 1 January. */
export function yearFraction(day: TradingDay): number {
  const date = parseTradingDay(day);
  return (date.dayOfYear - 1) / date.daysInYear;
}

/**
 * Generate `days` days of weather from `startDay`.
 *
 * - Mean maximum: 24.5 °C ± 6.5 °C, warmest in late January.
 * - Daily anomaly: AR(1), `a(t) = 0.6·a(t−1) + N(0, 2.5 °C)`, so warm and
 *   cool spells last a few days.
 * - Rain: chance 5% in summer rising to 45% in mid July; amount
 *   exponential with a 6 mm mean; a wet day is 2 °C cooler.
 *
 * Deterministic for a seed and start day; a shorter run is a prefix of a
 * longer one.
 */
export function syntheticWeather(
  seed: number,
  startDay: TradingDay,
  days: number,
): SyntheticWeatherDay[] {
  const rng = new Rng(seed, 'weather', startDay);
  const series: SyntheticWeatherDay[] = [];
  let anomaly = 0;
  for (let i = 0; i < days; i += 1) {
    const day = addDays(startDay, i);
    const t = yearFraction(day);
    const meanMax = 24.5 + 6.5 * Math.cos(TAU * (t - 25 / 365));
    anomaly = 0.6 * anomaly + rng.normal(0, 2.5);
    const rainChance = 0.05 + 0.4 * ((1 + Math.cos(TAU * (t - 196 / 365))) / 2);
    const wet = rng.chance(rainChance);
    const rainMm = wet ? -6 * Math.log(rng.uniform()) : 0;
    const maxTemp = meanMax + anomaly - (wet ? 2 : 0);
    series.push({
      trading_day: day,
      max_temp_tenths_c: Math.round(maxTemp * 10),
      rain_tenths_mm: Math.round(rainMm * 10),
    });
  }
  return series;
}
