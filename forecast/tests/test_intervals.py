"""Likely range: configuration, pooling, no leakage, and calibration on SYNTHETIC data."""

from __future__ import annotations

from dataclasses import replace
from datetime import date
from typing import Any

import numpy as np
import pytest

from foresite_forecast.baseline import BaselineConfig, BaselineModel
from foresite_forecast.intervals import (
    INTERVAL_EMPIRICAL_BUCKET,
    INTERVAL_EMPIRICAL_CELL,
    INTERVAL_FALLBACK,
    IntervalCalibrator,
    IntervalConfig,
    RatioBand,
    Residuals,
)
from foresite_forecast.model import Forecast
from foresite_forecast.synthetic import SyntheticDataset
from tests.conftest import Backtest
from tests.helpers import ISSUED

AS_OF = date(2026, 1, 1).toordinal()


def residuals(
    ratios: list[float],
    *,
    horizon: int = 1,
    weekday: int = 0,
    origin: int = AS_OF - 10,
    target: int | None = None,
) -> Residuals:
    n = len(ratios)
    return Residuals(
        np.full(n, origin, dtype=np.int64),
        np.full(n, origin + horizon if target is None else target, dtype=np.int64),
        np.full(n, horizon, dtype=np.int64),
        np.full(n, weekday, dtype=np.int64),
        np.array(ratios, dtype=np.float64),
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"q_low": 0.0},
        {"q_low": 0.9, "q_high": 0.1},
        {"q_high": 1.0},
        {"lookback_days": 6},
        {"min_residuals": 0},
        {"fallback_low_ratio": 1.1},
        {"fallback_high_ratio": 0.9},
        {"horizon_buckets": ((1, 7), (9, 28))},
        {"horizon_buckets": ((1, 7), (8, 27))},
        {"horizon_buckets": ((2, 28),)},
        {"horizon_buckets": ((1, 10), (8, 28))},
    ],
)
def test_config_is_validated(changes: dict[str, Any]) -> None:
    with pytest.raises(ValueError):  # noqa: PT011  # each case has its own message
        replace(IntervalConfig(), **changes)


def test_bucket_of() -> None:
    cfg = IntervalConfig()
    assert [cfg.bucket_of(h) for h in (1, 7, 8, 14, 15, 28)] == [0, 0, 1, 1, 2, 2]
    with pytest.raises(ValueError, match="outside"):
        cfg.bucket_of(29)


def test_residuals_validation_and_concat() -> None:
    with pytest.raises(ValueError, match="same length"):
        Residuals(
            np.zeros(1, dtype=np.int64),
            np.zeros(2, dtype=np.int64),
            np.zeros(1, dtype=np.int64),
            np.zeros(1, dtype=np.int64),
            np.zeros(1),
        )
    with pytest.raises(ValueError, match="horizons"):
        residuals([1.0], horizon=29)
    assert len(Residuals.concat([]).ratios) == 0
    assert len(Residuals.concat([residuals([1.0]), residuals([2.0, 3.0])]).ratios) == 3


def test_quantiles_are_clamped_so_the_point_is_always_inside() -> None:
    cfg = IntervalConfig(min_residuals=5)
    above = IntervalCalibrator(residuals([1.2, 1.3, 1.4, 1.5, 1.6]), AS_OF, cfg).band(1, 0)
    assert above.low_ratio == 1.0  # every past actual was above the point
    assert above.high_ratio == pytest.approx(1.56)
    below = IntervalCalibrator(residuals([0.5, 0.6, 0.7, 0.8, 0.9]), AS_OF, cfg).band(1, 0)
    assert below.high_ratio == 1.0
    assert below.low_ratio == pytest.approx(0.54)
    assert below.apply(100.0) == pytest.approx((54.0, 100.0))


def test_pooling_falls_back_from_cell_to_bucket_to_fixed() -> None:
    cfg = IntervalConfig(min_residuals=3)
    pool = Residuals.concat(
        [residuals([0.9, 1.0, 1.1], weekday=0), residuals([0.8, 1.2], weekday=1)]
    )
    cal = IntervalCalibrator(pool, AS_OF, cfg)
    assert cal.band(1, 0).rule == INTERVAL_EMPIRICAL_CELL
    assert cal.band(1, 0).n == 3
    assert cal.band(3, 1).rule == INTERVAL_EMPIRICAL_BUCKET  # Tuesday cell too thin
    assert cal.band(3, 1).n == 5
    fixed = cal.band(20, 0)  # no errors for 15-28 days ahead
    assert fixed == RatioBand(0.70, 1.30, INTERVAL_FALLBACK, 0)


def test_only_errors_known_by_as_of_and_within_lookback_are_used() -> None:
    cfg = IntervalConfig(min_residuals=1, lookback_days=30)
    pool = Residuals.concat(
        [
            residuals([5.0], origin=AS_OF - 2, target=AS_OF + 1),  # actual not known yet
            residuals([6.0], origin=AS_OF, target=AS_OF + 1),  # issued on as_of itself
            residuals([7.0], origin=AS_OF - 40, target=AS_OF - 39),  # outside lookback
            residuals([float("nan")]),
            residuals([1.25]),
        ]
    )
    band = IntervalCalibrator(pool, AS_OF, cfg).band(1, 0)
    assert band.n == 1
    assert band.high_ratio == 1.25


def test_interval_calibration_on_two_years_of_synthetic_data(backtest: Backtest) -> None:
    """A 10-90 range should hold the actual about 80% of the time."""
    actual = {
        (r.section_id, r.trading_day): r.metrics["net_sales_ex_gst_cents"]
        for r in backtest.dataset.actuals.rows
        if r.status == "open"
    }
    hits = total = 0
    by_bucket: dict[str, list[int]] = {}
    for f in backtest.forecasts:
        a = actual.get((f.section_id, f.target_day))
        if f.point is None or a is None or f.interval_rule != INTERVAL_EMPIRICAL_CELL:
            continue
        assert f.low is not None
        assert f.high is not None
        hit = int(f.low <= a <= f.high)
        hits += hit
        total += 1
        key = "1-7" if f.horizon_days <= 7 else "8-14" if f.horizon_days <= 14 else "15-28"
        by_bucket.setdefault(key, []).append(hit)
    assert total > 30_000
    assert 0.76 <= hits / total <= 0.84
    for bucket_hits in by_bucket.values():
        assert 0.74 <= sum(bucket_hits) / len(bucket_hits) <= 0.86


def test_wider_quantiles_give_wider_ranges(synthetic: SyntheticDataset) -> None:
    as_of = date(2026, 9, 30)

    def run(config: BaselineConfig) -> list[Forecast]:
        return BaselineModel(config).forecast(
            synthetic.actuals,
            as_of,
            metric="net_sales_ex_gst_cents",
            horizons=[7],
            issued_at=ISSUED,
            calendar=synthetic.calendar,
        )

    narrow = run(BaselineConfig())
    wide = run(BaselineConfig(intervals=IntervalConfig(q_low=0.05, q_high=0.95)))
    for n, w in zip(narrow, wide, strict=True):
        assert n.point == w.point
        assert w.low is not None
        assert n.low is not None
        assert w.high is not None
        assert n.high is not None
        assert w.low <= n.low
        assert w.high >= n.high
        assert (w.low, w.high) != (n.low, n.high)
