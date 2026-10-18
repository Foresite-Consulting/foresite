"""Small SYNTHETIC builders shared by the tests."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime, timedelta

from foresite_forecast.model import Forecast
from foresite_forecast.schema import DailyActuals, daily_actuals_from_rows

VENUE = "SYNTH-V"
SECTION = "synth-s1"
METRIC = "net_sales_ex_gst_cents"
ISSUED = datetime(2026, 1, 1, tzinfo=UTC)

#: Monday..Sunday multipliers for the hand-built series.
WEEKDAY = (1.0, 1.0, 1.0, 1.2, 1.5, 2.0, 1.3)

Value = int | None | str


def build_actuals(
    start: date,
    values: Sequence[Value],
    *,
    venue: str = VENUE,
    section: str = SECTION,
) -> DailyActuals:
    """A one-series table: int = open with that value, None = missing, 'closed' = closed."""
    rows: list[dict[str, object]] = []
    for i, v in enumerate(values):
        day = start + timedelta(days=i)
        row: dict[str, object] = {"venue_id": venue, "section_id": section, "trading_day": day}
        if v is None:
            row["status"] = "missing"
            row[METRIC] = None
        elif v == "closed":
            row["status"] = "closed"
            row[METRIC] = None
        else:
            row["status"] = "open"
            row[METRIC] = v
        rows.append(row)
    return daily_actuals_from_rows(rows)


def series_values(start: date, days: int, value: Callable[[date], Value]) -> list[Value]:
    """Values for ``days`` consecutive days from ``start``."""
    return [value(start + timedelta(days=i)) for i in range(days)]


def growth_value(level_y1: float = 10_000.0, growth: float = 1.10) -> Callable[[date], int]:
    """Weekday pattern, level x ``growth`` from 2025 onwards (exact, no noise)."""

    def value(day: date) -> int:
        level = level_y1 * (growth if day.year >= 2025 else 1.0)
        return round(level * WEEKDAY[day.weekday()])

    return value


def make_forecast(
    target: date,
    point: int | None,
    *,
    horizon: int = 1,
    low: int | None = None,
    high: int | None = None,
    model_id: str = "model-a",
    section: str = SECTION,
    venue: str = VENUE,
    issued_at: datetime = ISSUED,
    rule: str | None = None,
) -> Forecast:
    """A forecast record with sensible defaults (range = point unless given)."""
    if point is None:
        return Forecast(
            issued_at=issued_at,
            model_id=model_id,
            model_version="1",
            venue_id=venue,
            section_id=section,
            metric=METRIC,
            as_of=target - timedelta(days=horizon),
            target_day=target,
            horizon_days=horizon,
            point=None,
            low=None,
            high=None,
            rule="unforecastable",
        )
    return Forecast(
        issued_at=issued_at,
        model_id=model_id,
        model_version="1",
        venue_id=venue,
        section_id=section,
        metric=METRIC,
        as_of=target - timedelta(days=horizon),
        target_day=target,
        horizon_days=horizon,
        point=point,
        low=point if low is None else low,
        high=point if high is None else high,
        rule=rule or "test_rule",
        interval_rule="test_interval",
    )
