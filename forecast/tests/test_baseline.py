"""Baseline rules, one test per rule, on exact hand-built SYNTHETIC series."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest

from foresite_forecast.baseline import (
    ALL_HORIZONS,
    BASELINE_RULES_VERSION,
    LAST_YEAR_SHIFT_DAYS,
    RULE_CLOSED,
    RULE_HOLIDAY,
    RULE_NEIGHBOURS,
    RULE_RECENT,
    RULE_SWLY,
    TREND_CAPPED,
    TREND_INSUFFICIENT,
    TREND_WINDOW,
    TREND_ZERO_BASE,
    BaselineConfig,
    BaselineModel,
    SeriesBaseline,
    _round_half_up,
    nominal_issued_at,
)
from foresite_forecast.intervals import (
    INTERVAL_CLOSED,
    INTERVAL_EMPIRICAL_BUCKET,
    INTERVAL_FALLBACK,
    INTERVAL_ZERO_POINT,
    IntervalConfig,
)
from foresite_forecast.model import UNFORECASTABLE, Forecast, ForecastModel
from foresite_forecast.schema import DailyActuals, VenueCalendar, daily_actuals_from_rows
from tests.helpers import (
    ISSUED,
    METRIC,
    SECTION,
    VENUE,
    Value,
    build_actuals,
    growth_value,
    series_values,
)

START = date(2024, 1, 1)  # a Monday; 2024 is a leap year


def two_years(value: Callable[[date], Value] | None = None) -> DailyActuals:
    return build_actuals(START, series_values(START, 731, value or growth_value()))


def one(
    actuals: DailyActuals,
    as_of: date,
    horizon: int = 1,
    calendar: VenueCalendar | None = None,
    config: BaselineConfig | None = None,
) -> Forecast:
    (fc,) = BaselineModel(config).forecast(
        actuals, as_of, metric=METRIC, horizons=[horizon], issued_at=ISSUED, calendar=calendar
    )
    return fc


def cal(holidays: dict[date, str] | None = None, closed: set[date] | None = None) -> VenueCalendar:
    return VenueCalendar(holidays={None: holidays or {}}, closed={None: frozenset(closed or set())})


def test_same_weekday_last_year_times_trend() -> None:
    fc = one(two_years(), date(2025, 6, 30))
    assert fc.target_day == date(2025, 7, 1)
    assert fc.rule == RULE_SWLY
    assert fc.reference_days == (date(2024, 7, 2),)
    assert fc.reference_days[0].weekday() == fc.target_day.weekday()
    assert fc.trend_factor == pytest.approx(1.1)
    assert fc.trend_rule == TREND_WINDOW
    assert fc.point == 11_000
    assert fc.low is not None
    assert fc.high is not None
    assert fc.low <= fc.point <= fc.high
    assert fc.model_id == "baseline-swly-trend"
    assert fc.model_version == BASELINE_RULES_VERSION


def test_shift_is_364_days_across_a_leap_day() -> None:
    fc = one(two_years(), date(2025, 2, 28))
    # 1 Mar 2025 (Saturday) is compared with 2 Mar 2024 (Saturday), not 1 Mar 2024 (Friday).
    assert LAST_YEAR_SHIFT_DAYS == 364
    assert fc.reference_days == (date(2024, 3, 2),)
    assert fc.point == 22_000  # 10 000 x 2.0 (Saturday) x 1.1 trend


def test_holiday_matches_last_years_holiday_even_when_the_date_moves() -> None:
    def value(day: date) -> Value:
        return 30_000 if day == date(2024, 4, 1) else growth_value()(day)

    calendar = cal({date(2024, 4, 1): "easter_monday", date(2025, 4, 21): "easter_monday"})
    fc = one(two_years(value), date(2025, 4, 20), calendar=calendar)
    assert fc.rule == RULE_HOLIDAY
    assert fc.reference_days == (date(2024, 4, 1),)
    assert fc.trend_rule == TREND_WINDOW
    assert fc.point == 33_000  # the holiday itself is left out of the trend window


def test_normal_day_whose_last_year_day_was_a_holiday_uses_neighbours() -> None:
    def value(day: date) -> Value:
        return 30_000 if day == date(2024, 4, 1) else growth_value()(day)

    calendar = cal({date(2024, 4, 1): "easter_monday"})
    fc = one(two_years(value), date(2025, 3, 30), calendar=calendar)
    assert fc.target_day == date(2025, 3, 31)
    assert fc.rule == RULE_NEIGHBOURS
    assert fc.reference_days == (
        date(2024, 3, 18),
        date(2024, 3, 25),
        date(2024, 4, 8),
        date(2024, 4, 15),
    )
    assert fc.point == 11_000


def test_unusable_holiday_last_year_falls_back_to_the_normal_chain() -> None:
    # Closed on Christmas last year, open this year: last year's Christmas is unusable.
    calendar = VenueCalendar(
        holidays={None: {date(2024, 12, 25): "christmas_day", date(2025, 12, 25): "christmas_day"}},
        closed={VENUE: frozenset({date(2024, 12, 25)})},
    )
    fc = one(two_years(), date(2025, 12, 24), calendar=calendar)
    assert fc.rule == RULE_SWLY
    assert fc.reference_days == (date(2024, 12, 26),)


def test_planned_closure_is_zero_with_zero_range() -> None:
    fc = one(two_years(), date(2025, 6, 30), calendar=cal(closed={date(2025, 7, 1)}))
    assert (fc.point, fc.low, fc.high) == (0, 0, 0)
    assert fc.rule == RULE_CLOSED
    assert fc.interval_rule == INTERVAL_CLOSED
    assert fc.trend_factor is None


def test_missing_last_year_falls_back_to_neighbours_then_recent_median() -> None:
    def value(day: date) -> Value:
        if date(2024, 6, 15) <= day <= date(2024, 7, 20):
            return None  # explicit gap last year
        return growth_value()(day)

    fc = one(two_years(value), date(2025, 6, 30))
    # Ref 2 Jul 2024 and neighbours 18/25 Jun, 9/16 Jul 2024 are all in the gap.
    assert fc.rule == RULE_RECENT
    assert fc.trend_factor is None
    assert len(fc.reference_days) == 8
    assert fc.point == 11_000  # Tuesday at this year's level, no trend applied


def test_new_venue_uses_recent_median_then_becomes_unforecastable() -> None:
    start = date(2025, 1, 1)
    actuals = build_actuals(start, series_values(start, 40, growth_value()))
    fc = one(actuals, date(2025, 2, 5), horizon=3)
    assert fc.rule == RULE_RECENT
    assert fc.trend_rule is None
    # Five weeks in: enough past errors for the horizon bucket, not per weekday.
    assert fc.interval_rule == INTERVAL_EMPIRICAL_BUCKET
    early = one(actuals, date(2025, 1, 22), horizon=3)
    assert early.rule == RULE_RECENT
    assert early.interval_rule == INTERVAL_FALLBACK  # three weeks in: fixed fallback width
    assert early.point is not None
    assert early.low == pytest.approx(0.7 * early.point, abs=1)
    assert early.high == pytest.approx(1.3 * early.point, abs=1)
    tiny = build_actuals(start, series_values(start, 10, growth_value()))
    unf = one(tiny, date(2025, 1, 10), horizon=7)
    assert unf.rule == UNFORECASTABLE
    assert (unf.point, unf.low, unf.high) == (None, None, None)
    assert not unf.forecastable


def test_as_of_before_a_series_starts_is_unforecastable_for_that_series() -> None:
    rows: list[dict[str, object]] = []
    for i in range(30):
        day = date(2025, 1, 1) + timedelta(days=i)
        rows.append({"venue_id": VENUE, "section_id": "a", "trading_day": day, METRIC: 100})
        if i >= 20:
            rows.append({"venue_id": VENUE, "section_id": "b", "trading_day": day, METRIC: 100})
    forecasts = BaselineModel().forecast(
        daily_actuals_from_rows(rows),
        date(2025, 1, 25),
        metric=METRIC,
        horizons=[1],
        issued_at=ISSUED,
    )
    by_section = {f.section_id: f for f in forecasts}
    assert by_section["a"].rule == RULE_RECENT
    assert by_section["b"].rule == UNFORECASTABLE


def test_trend_insufficient_history_uses_one() -> None:
    fc = one(two_years(), date(2025, 1, 10))
    assert fc.rule == RULE_SWLY
    assert fc.trend_rule == TREND_INSUFFICIENT
    assert fc.trend_factor == 1.0
    assert fc.point == 20_000  # Saturday 13 Jan 2024 unscaled


@pytest.mark.parametrize(("growth", "factor"), [(3.0, 2.0), (0.2, 0.5)])
def test_trend_is_capped(growth: float, factor: float) -> None:
    fc = one(two_years(growth_value(growth=growth)), date(2025, 6, 30))
    assert fc.trend_rule == TREND_CAPPED
    assert fc.trend_factor == factor


def test_trend_cap_is_configurable() -> None:
    config = BaselineConfig(trend_cap=4.0)
    fc = one(two_years(growth_value(growth=3.0)), date(2025, 6, 30), config=config)
    assert fc.trend_rule == TREND_WINDOW
    assert fc.trend_factor == pytest.approx(3.0)
    assert fc.model_version.startswith(f"{BASELINE_RULES_VERSION}+cfg.")


def test_zero_base_last_year() -> None:
    def zero_then_sales(day: date) -> Value:
        return 0 if day.year == 2024 else 1_000

    fc = one(two_years(zero_then_sales), date(2025, 6, 30))
    assert fc.trend_rule == TREND_CAPPED
    assert fc.trend_factor == 2.0
    assert fc.point == 0  # last year's day was 0
    assert fc.interval_rule == INTERVAL_ZERO_POINT
    assert (fc.low, fc.high) == (0, 1_000)  # 0 to the highest recent same-weekday actual

    all_zero = one(two_years(lambda d: 0), date(2025, 6, 30))
    assert all_zero.trend_rule == TREND_ZERO_BASE
    assert all_zero.trend_factor == 1.0
    assert (all_zero.point, all_zero.low, all_zero.high) == (0, 0, 0)


def test_data_after_as_of_is_never_used() -> None:
    as_of = date(2025, 6, 30)
    base = two_years()
    later = two_years(lambda d: 999_999 if d > as_of else growth_value()(d))
    model = BaselineModel()
    a = model.forecast(base, as_of, metric=METRIC, issued_at=ISSUED)
    b = model.forecast(later, as_of, metric=METRIC, issued_at=ISSUED)
    assert a == b


def test_backtest_matches_single_forecasts() -> None:
    actuals = two_years()
    model = BaselineModel()
    origins = [date(2025, 6, 1), date(2025, 6, 15)]
    bt = model.backtest(actuals, origins + origins[:1], metric=METRIC, horizons=(1, 14, 28))
    single = [
        f
        for o in origins
        for f in model.forecast(
            actuals, o, metric=METRIC, horizons=(1, 14, 28), issued_at=nominal_issued_at(o)
        )
    ]
    assert bt == single
    assert nominal_issued_at(date(2025, 6, 1)) == datetime(2025, 6, 2, tzinfo=UTC)
    with pytest.raises(ValueError, match="on or before"):
        model.backtest(actuals, [date(2026, 6, 1)], metric=METRIC)


def test_forecast_horizons_default_to_all_28_days() -> None:
    forecasts = BaselineModel().forecast(
        two_years(), date(2025, 6, 30), metric=METRIC, issued_at=ISSUED
    )
    assert [f.horizon_days for f in forecasts] == list(ALL_HORIZONS)
    assert len(ALL_HORIZONS) == 28


@pytest.mark.parametrize(
    ("horizons", "message"),
    [
        ([], "at least one"),
        ([1, 1], "must not repeat"),
        ([0], "1 to 28"),
        ([29], "1 to 28"),
        ([True], "1 to 28"),
    ],
)
def test_rejects_bad_horizons(horizons: list[int], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        BaselineModel().forecast(
            two_years(), date(2025, 6, 30), metric=METRIC, horizons=horizons, issued_at=ISSUED
        )


def test_rejects_as_of_after_last_actuals() -> None:
    with pytest.raises(ValueError, match="after the last trading day"):
        BaselineModel().forecast(two_years(), date(2026, 1, 1), metric=METRIC, issued_at=ISSUED)


@pytest.mark.parametrize(
    "changes",
    [
        {"trend_window_days": 10},
        {"trend_window_days": 0},
        {"trend_min_pairs": 0},
        {"trend_min_pairs": 57},
        {"trend_floor": 0.0},
        {"trend_floor": 1.5},
        {"trend_cap": 0.9},
        {"neighbour_weeks": 0},
        {"neighbour_min_count": 5},
        {"recent_weeks": 0},
        {"recent_min_count": 9},
    ],
)
def test_config_is_validated(changes: dict[str, Any]) -> None:
    with pytest.raises(ValueError):  # noqa: PT011  # each case has its own message
        replace(BaselineConfig(), **changes)


def test_model_version_tracks_config() -> None:
    assert BaselineModel().model_version == BASELINE_RULES_VERSION
    a = BaselineModel(BaselineConfig(intervals=IntervalConfig(q_low=0.05, q_high=0.95)))
    b = BaselineModel(BaselineConfig(intervals=IntervalConfig(q_low=0.05, q_high=0.95)))
    assert a.model_version == b.model_version != BASELINE_RULES_VERSION


def test_baseline_implements_the_model_interface() -> None:
    assert isinstance(BaselineModel(), ForecastModel)


def test_round_half_up() -> None:
    assert [_round_half_up(x) for x in (0.5, 1.5, 2.4999, 2.5)] == [1, 2, 2, 3]


def test_series_engine_memoises() -> None:
    actuals = two_years()
    engine = SeriesBaseline(
        actuals.series(VENUE, SECTION, METRIC), VenueCalendar.empty(), BaselineConfig()
    )
    assert engine.point(date(2025, 6, 30), 1) is engine.point(date(2025, 6, 30), 1)
    assert engine.trend(date(2025, 6, 30)) is engine.trend(date(2025, 6, 30))


# -- the Forecast record --------------------------------------------------------------


VALID = Forecast(
    issued_at=ISSUED,
    model_id="m",
    model_version="1",
    venue_id=VENUE,
    section_id=SECTION,
    metric=METRIC,
    as_of=date(2026, 1, 1),
    target_day=date(2026, 1, 2),
    horizon_days=1,
    point=10,
    low=5,
    high=15,
    rule="r",
    interval_rule="i",
)


def _fc(**changes: Any) -> Forecast:
    return replace(VALID, **changes)


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"issued_at": datetime(2026, 1, 1)}, "timezone-aware"),
        ({"horizon_days": 0, "target_day": date(2026, 1, 1)}, "horizon_days must be"),
        ({"horizon_days": 2}, "must equal"),
        ({"rule": ""}, "provenance"),
        ({"point": None, "low": None, "high": None}, "rule 'unforecastable'"),
        ({"low": None}, "all be set"),
        ({"low": 11}, "low <= point <= high"),
        ({"high": 9}, "low <= point <= high"),
        ({"low": -1}, "low <= point <= high"),
        ({"rule": UNFORECASTABLE}, "must not have a point"),
        ({"interval_rule": None}, "interval_rule"),
    ],
)
def test_forecast_record_invariants(changes: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        _fc(**changes)


def test_forecast_record_accepts_unforecastable() -> None:
    fc = _fc(point=None, low=None, high=None, rule=UNFORECASTABLE, interval_rule=None)
    assert not fc.forecastable
