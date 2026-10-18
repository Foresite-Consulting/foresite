"""Property-based tests (hypothesis) for the invariants the business relies on.

Every series here is SYNTHETIC, generated from a drawn seed.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Literal

import numpy as np
from hypothesis import assume, given, settings
from hypothesis import strategies as st

from foresite_forecast.accuracy import forecasts_to_frame, metrics, score
from foresite_forecast.baseline import (
    LAST_YEAR_SHIFT_DAYS,
    POINT_RULES,
    RULE_NEIGHBOURS,
    RULE_RECENT,
    RULE_SWLY,
    BaselineModel,
)
from foresite_forecast.intervals import IntervalCalibrator, IntervalConfig, Residuals
from foresite_forecast.model import UNFORECASTABLE, Forecast
from foresite_forecast.schema import DailyActuals
from foresite_forecast.selection import decide_rollback
from tests.helpers import ISSUED, METRIC, Value, build_actuals, make_forecast
from tests.test_selection import Mode, scenario

START = date(2024, 1, 1)


@st.composite
def random_series(draw: st.DrawFn) -> tuple[DailyActuals, date, list[int]]:
    """A SYNTHETIC series with gaps, closures and zeros, an as-of day and horizons."""
    n = draw(st.integers(min_value=1, max_value=800))
    seed = draw(st.integers(min_value=0, max_value=2**32 - 1))
    p_missing = draw(st.sampled_from([0.0, 0.05, 0.3]))
    p_closed = draw(st.sampled_from([0.0, 0.02]))
    p_zero = draw(st.sampled_from([0.0, 0.1]))
    rng = np.random.default_rng(seed)
    level = float(rng.uniform(100, 2_000_000))
    values: list[Value] = []
    for i in range(n):
        u = rng.random()
        if u < p_missing:
            values.append(None)
        elif u < p_missing + p_closed:
            values.append("closed")
        elif u < p_missing + p_closed + p_zero:
            values.append(0)
        else:
            values.append(int(level * (1 + 0.5 * (i % 7) / 6) * rng.lognormal(0, 0.2)))
    as_of = START + timedelta(days=draw(st.integers(min_value=0, max_value=n - 1)))
    horizons = draw(st.lists(st.integers(1, 28), min_size=1, max_size=6, unique=True))
    return build_actuals(START, values), as_of, horizons


def usable(actuals: DailyActuals, day: date, as_of: date) -> bool:
    s = actuals.series(*actuals.series_keys()[0], METRIC)
    return day <= as_of and s.value_on(day) is not None


@given(random_series())
def test_every_forecast_is_well_formed(case: tuple[DailyActuals, date, list[int]]) -> None:
    actuals, as_of, horizons = case
    forecasts = BaselineModel().forecast(
        actuals, as_of, metric=METRIC, horizons=horizons, issued_at=ISSUED
    )
    assert [f.horizon_days for f in forecasts] == horizons  # one per horizon, none dropped
    for f in forecasts:
        assert f.rule in POINT_RULES  # provenance always set
        if f.forecastable:
            assert f.low is not None
            assert f.point is not None
            assert f.high is not None
            assert 0 <= f.low <= f.point <= f.high
            assert f.interval_rule
            assert all(d <= as_of for d in f.reference_days)  # nothing from the future
        else:
            assert f.rule == UNFORECASTABLE
            assert (f.low, f.high, f.interval_rule) == (None, None, None)


@given(random_series())
def test_no_forecast_without_history_unless_a_fallback_applies(
    case: tuple[DailyActuals, date, list[int]],
) -> None:
    """An independent check of the fallback chain (no calendar in this test)."""
    actuals, as_of, horizons = case
    for f in BaselineModel().forecast(
        actuals, as_of, metric=METRIC, horizons=horizons, issued_at=ISSUED
    ):
        t = f.target_day
        ref = t - timedelta(days=LAST_YEAR_SHIFT_DAYS)
        neighbours = [ref + timedelta(days=7 * k) for k in (-2, -1, 1, 2)]
        recent: list[date] = []
        d = t - timedelta(days=7)
        while d > as_of:
            d -= timedelta(days=7)
        recent = [d - timedelta(days=7 * j) for j in range(8)]
        expected = (
            RULE_SWLY
            if usable(actuals, ref, as_of)
            else RULE_NEIGHBOURS
            if sum(usable(actuals, x, as_of) for x in neighbours) >= 2
            else RULE_RECENT
            if sum(usable(actuals, x, as_of) for x in recent) >= 3
            else UNFORECASTABLE
        )
        assert f.rule == expected
        for day in f.reference_days:
            assert usable(actuals, day, as_of)


@settings(max_examples=20)
@given(random_series(), st.integers(min_value=0, max_value=10_000_000))
def test_forecasts_are_deterministic_and_ignore_later_data(
    case: tuple[DailyActuals, date, list[int]], noise: int
) -> None:
    actuals, as_of, horizons = case
    model = BaselineModel()
    first = model.forecast(actuals, as_of, metric=METRIC, horizons=horizons, issued_at=ISSUED)
    second = BaselineModel().forecast(
        actuals, as_of, metric=METRIC, horizons=horizons, issued_at=ISSUED
    )
    assert first == second
    series = actuals.series(*actuals.series_keys()[0], METRIC)
    changed: list[Value] = []
    for i in range(len(series.values)):
        day = START + timedelta(days=i)
        v = series.values[i]
        status = int(series.status[i])
        if day > as_of:
            changed.append(noise)
        elif status == 1:
            changed.append("closed")
        elif status == 2 or np.isnan(v):
            changed.append(None)
        else:
            changed.append(int(v))
    later = BaselineModel().forecast(
        build_actuals(START, changed), as_of, metric=METRIC, horizons=horizons, issued_at=ISSUED
    )
    assert later == first


@given(
    st.lists(st.floats(min_value=0.0, max_value=10.0), min_size=1, max_size=60),
    st.floats(min_value=0.0, max_value=1e9),
    st.integers(1, 28),
    st.integers(0, 6),
)
def test_ratio_band_always_contains_the_point(
    ratios: list[float], point: float, horizon: int, weekday: int
) -> None:
    n = len(ratios)
    res = Residuals(
        np.full(n, 10, dtype=np.int64),
        np.full(n, 11, dtype=np.int64),
        np.full(n, horizon, dtype=np.int64),
        np.full(n, weekday, dtype=np.int64),
        np.array(ratios),
    )
    band = IntervalCalibrator(res, 20, IntervalConfig(min_residuals=1)).band(horizon, weekday)
    low, high = band.apply(point)
    assert low <= point <= high


@given(
    st.lists(
        st.tuples(st.integers(0, 10_000), st.integers(0, 10_000), st.integers(0, 3)),
        min_size=1,
        max_size=40,
    )
)
def test_metrics_match_a_direct_calculation(rows: list[tuple[int, int, int]]) -> None:
    mon = date(2026, 1, 5)
    actual_values: list[Value] = [a for a, _, _ in rows]
    actuals = build_actuals(mon, actual_values)
    forecasts: list[Forecast] = [
        make_forecast(mon + timedelta(days=i), p, low=max(p - w * 100, 0), high=p + w * 100)
        for i, (_, p, w) in enumerate(rows)
    ]
    (m,) = metrics(score(forecasts_to_frame(forecasts), actuals)).iter_rows(named=True)
    total = sum(a for a, _, _ in rows)
    abs_err = sum(abs(a - p) for a, p, _ in rows)
    hits = sum(max(p - w * 100, 0) <= a <= p + w * 100 for a, p, w in rows)
    assert m["n"] == len(rows)
    assert m["coverage"] == hits / len(rows)
    if total == 0:
        assert m["wape"] is None
    else:
        assert abs(m["wape"] - abs_err / total) < 1e-12
        assert abs(m["bias"] - sum(p - a for a, p, _ in rows) / total) < 1e-12


Verdict = Literal["worse", "not_worse", "insufficient"]
MODES: list[Mode] = ["better", "tie", "worse", "missing", "thin"]
MODE_VERDICT: dict[Mode, Verdict] = {
    "better": "not_worse",
    "tie": "not_worse",
    "worse": "worse",
    "missing": "insufficient",
    "thin": "insufficient",
}


@given(st.lists(st.sampled_from(MODES), min_size=1, max_size=7))
def test_rollback_only_after_four_complete_consecutive_worse_weeks(modes: list[Mode]) -> None:
    assume(any(m != "missing" for m in modes))  # an empty challenger log is an error, tested apart
    s = scenario(modes)
    (d,) = decide_rollback(s.challenger, s.baseline, s.actuals)
    last4 = [MODE_VERDICT[m] for m in modes[-4:]]
    if len(modes) >= 4 and all(v == "worse" for v in last4):
        assert d.decision == "rollback_to_baseline"
        assert d.alert is not None
    elif "not_worse" in last4:
        assert d.decision == "keep"
    else:
        assert d.decision == "insufficient_data"
    if d.decision != "rollback_to_baseline":
        assert d.alert is None
        assert d.serve_model_id == "challenger-x"
