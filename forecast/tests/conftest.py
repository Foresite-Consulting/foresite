"""Shared fixtures. All data is SYNTHETIC."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import pytest
from hypothesis import HealthCheck, settings

from foresite_forecast.baseline import BaselineModel
from foresite_forecast.model import Forecast
from foresite_forecast.synthetic import SyntheticDataset, generate_synthetic

# Deterministic property tests: the same examples on every run and in CI.
settings.register_profile(
    "foresite",
    derandomize=True,
    database=None,
    deadline=None,
    max_examples=40,
    suppress_health_check=[HealthCheck.too_slow],
)
settings.load_profile("foresite")

SYNTH_START = date(2023, 7, 1)
SYNTH_END = date(2026, 10, 18)
#: Two years of origins for the end-to-end backtest.
BACKTEST_START = date(2024, 10, 19)
BACKTEST_END = date(2026, 10, 17)


@dataclass(frozen=True)
class Backtest:
    dataset: SyntheticDataset
    forecasts: list[Forecast]


@pytest.fixture(scope="session")
def synthetic() -> SyntheticDataset:
    """About 3.3 years of SYNTHETIC daily actuals for two sections."""
    return generate_synthetic(SYNTH_START, SYNTH_END)


@pytest.fixture(scope="session")
def backtest(synthetic: SyntheticDataset) -> Backtest:
    """Two years of rolling baseline forecasts (all 28 horizons) over the SYNTHETIC data."""
    origins = [
        BACKTEST_START + timedelta(days=i) for i in range((BACKTEST_END - BACKTEST_START).days + 1)
    ]
    forecasts = BaselineModel().backtest(
        synthetic.actuals,
        origins,
        metric="net_sales_ex_gst_cents",
        calendar=synthetic.calendar,
    )
    return Backtest(synthetic, forecasts)
