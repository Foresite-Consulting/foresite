"""The SYNTHETIC generator: deterministic, clearly labelled, with the features tests rely on."""

from __future__ import annotations

from collections.abc import Callable
from datetime import date

import pytest

from foresite_forecast.synthetic import (
    SYNTHETIC_VENUE,
    calendar_rows,
    easter_sunday,
    generate_synthetic,
    synthetic_holidays,
)


@pytest.mark.parametrize(
    ("year", "easter"),
    [
        (2000, date(2000, 4, 23)),
        (2019, date(2019, 4, 21)),
        (2024, date(2024, 3, 31)),
        (2025, date(2025, 4, 20)),
        (2026, date(2026, 4, 5)),
    ],
)
def test_easter(year: int, easter: date) -> None:
    assert easter_sunday(year) == easter


def test_holidays_2026() -> None:
    holidays = {k: d for d, k in synthetic_holidays(date(2026, 1, 1), date(2026, 12, 31))}
    assert holidays["labour_day"] == date(2026, 3, 2)
    assert holidays["good_friday"] == date(2026, 4, 3)
    assert holidays["easter_monday"] == date(2026, 4, 6)
    assert holidays["wa_day"] == date(2026, 6, 1)
    assert holidays["kings_birthday"] == date(2026, 9, 28)
    assert holidays["christmas_day"] == date(2026, 12, 25)
    assert len(holidays) == 10
    december = synthetic_holidays(date(2026, 12, 1), date(2026, 12, 31))
    assert [k for _, k in december] == ["christmas_day", "boxing_day"]


def test_generator_is_deterministic_and_labelled() -> None:
    a = generate_synthetic(date(2025, 1, 1), date(2025, 12, 31), seed=7)
    b = generate_synthetic(date(2025, 1, 1), date(2025, 12, 31), seed=7)
    c = generate_synthetic(date(2025, 1, 1), date(2025, 12, 31), seed=8)
    assert a.actuals.rows == b.actuals.rows
    assert a.actuals.rows != c.actuals.rows
    for row in a.actuals.rows:
        assert row.venue_id == SYNTHETIC_VENUE
        assert row.section_id.startswith("synth-")
    statuses = {r.trading_day: r.status for r in a.actuals.rows}
    assert statuses[date(2025, 12, 25)] == "closed"
    assert a.closed_days == (date(2025, 12, 25),)
    assert len(a.missing_days) == 5
    assert all(statuses[d] == "missing" for d in a.missing_days)
    assert a.calendar.is_closed(SYNTHETIC_VENUE, date(2025, 12, 25))
    assert a.calendar.holiday_key(SYNTHETIC_VENUE, date(2025, 4, 25)) == "anzac_day"
    rows = calendar_rows(a)
    assert ("", "2025-12-25", "closed", "") in rows
    assert ("", "2025-12-25", "public_holiday", "christmas_day") in rows


def test_generator_shape() -> None:
    ds = generate_synthetic(date(2024, 1, 1), date(2025, 12, 31), gap_start=date(2030, 1, 1))
    assert ds.missing_days == ()
    sales = {
        (r.section_id, r.trading_day): r.metrics["net_sales_ex_gst_cents"]
        for r in ds.actuals.rows
        if r.status == "open"
    }

    def mean(section: str, pick: Callable[[date], bool]) -> float:
        vals = [v for (s, d), v in sales.items() if s == section and v is not None and pick(d)]
        return sum(vals) / len(vals)

    bar = "synth-bar"
    assert mean(bar, lambda d: d.weekday() == 5) > 1.5 * mean(bar, lambda d: d.weekday() == 0)
    assert mean(bar, lambda d: d.month == 1) > mean(bar, lambda d: d.month == 7)  # summer peak
    assert mean(bar, lambda d: d.year == 2025) > mean(bar, lambda d: d.year == 2024)  # growth
    with pytest.raises(ValueError, match="end must not be before start"):
        generate_synthetic(date(2025, 1, 2), date(2025, 1, 1))
