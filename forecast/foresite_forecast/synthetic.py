"""SYNTHETIC data for tests, demos and backtests. Not real data from any venue.

Every identifier starts with ``SYNTH`` / ``synth`` so synthetic rows can never
be mistaken for a client's. The series has what real hospitality sales have:
a weekday pattern (Friday and Saturday busiest), Southern Hemisphere
seasonality (busiest in January, quietest in July), growth, public holidays
(busier), one closure (Christmas Day), multiplicative noise and an explicit
run of ``missing`` days. Everything is seeded and deterministic.

The public holiday list is a simplified approximation of Western Australian
holidays (no substitute days) for synthetic data only. It is not an
authoritative calendar; real builds load the venue calendar from
``packages/core``.

The challenger generators are test oracles: they look at the actuals to make a
model that is known to be better or worse than the baseline. They exist only
to test the selection, rollback and gate logic.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal

import numpy as np
import polars as pl

from foresite_forecast.schema import DailyActuals, DailyRow, VenueCalendar

SYNTHETIC_VENUE = "SYNTH-VENUE-1"
SYNTHETIC_SECTIONS: tuple[str, ...] = ("synth-bar", "synth-restaurant")
_SECTION_LEVEL_CENTS = {"synth-bar": 650_000.0, "synth-restaurant": 1_150_000.0}
#: Monday..Sunday multipliers.
_WEEKDAY = (0.70, 0.75, 0.85, 0.95, 1.35, 1.55, 1.10)
_HOLIDAY_LIFT = 1.25
_SPEND_PER_HEAD_CENTS = 4_500.0


def easter_sunday(year: int) -> date:
    """Western (Gregorian) Easter Sunday (anonymous Gregorian algorithm)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l_ = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l_) // 451
    month, day = divmod(h + l_ - 7 * m + 114, 31)
    return date(year, month, day + 1)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    last = nxt - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def synthetic_holidays(start: date, end: date) -> list[tuple[date, str]]:
    """Approximate WA public holidays between ``start`` and ``end`` (inclusive), sorted."""
    found: list[tuple[date, str]] = []
    for year in range(start.year, end.year + 1):
        easter = easter_sunday(year)
        for d, key in (
            (date(year, 1, 1), "new_years_day"),
            (date(year, 1, 26), "australia_day"),
            (_nth_weekday(year, 3, 0, 1), "labour_day"),
            (easter - timedelta(days=2), "good_friday"),
            (easter + timedelta(days=1), "easter_monday"),
            (date(year, 4, 25), "anzac_day"),
            (_nth_weekday(year, 6, 0, 1), "wa_day"),
            (_last_weekday(year, 9, 0), "kings_birthday"),
            (date(year, 12, 25), "christmas_day"),
            (date(year, 12, 26), "boxing_day"),
        ):
            if start <= d <= end:
                found.append((d, key))
    return sorted(found)


@dataclass(frozen=True)
class SyntheticDataset:
    """SYNTHETIC actuals plus the calendar used to make them."""

    actuals: DailyActuals
    calendar: VenueCalendar
    holidays: tuple[tuple[date, str], ...]
    closed_days: tuple[date, ...]
    missing_days: tuple[date, ...]


def generate_synthetic(
    start: date,
    end: date,
    *,
    seed: int = 20261019,
    sections: Sequence[str] = SYNTHETIC_SECTIONS,
    annual_growth: float = 0.06,
    seasonality: float = 0.15,
    noise_sigma: float = 0.08,
    gap_start: date | None = None,
    gap_days: int = 5,
    closed_holidays: Sequence[str] = ("christmas_day",),
) -> SyntheticDataset:
    """Generate a deterministic SYNTHETIC daily series for one venue.

    ``gap_start`` defaults to 200 days after ``start``; pass a date outside
    the range to have no gap.
    """
    if end < start:
        raise ValueError("end must not be before start")
    holidays = synthetic_holidays(start, end)
    holiday_on = dict(holidays)
    closed = tuple(d for d, k in holidays if k in closed_holidays)
    gap_first = gap_start if gap_start is not None else start + timedelta(days=200)
    missing = tuple(
        gap_first + timedelta(days=i)
        for i in range(gap_days)
        if start <= gap_first + timedelta(days=i) <= end
    )
    rng = np.random.default_rng(seed)
    n = (end - start).days + 1
    rows: list[DailyRow] = []
    for section in sections:
        level = _SECTION_LEVEL_CENTS.get(section, 800_000.0)
        noise = rng.normal(0.0, noise_sigma, size=n)
        head_noise = rng.normal(0.0, 0.05, size=n)
        for i in range(n):
            day = start + timedelta(days=i)
            if day in closed:
                rows.append(
                    DailyRow(SYNTHETIC_VENUE, section, day, "closed", _metrics(None, None, None))
                )
                continue
            if day in missing:
                rows.append(
                    DailyRow(SYNTHETIC_VENUE, section, day, "missing", _metrics(None, None, None))
                )
                continue
            years = i / 365.25
            season = 1.0 + seasonality * math.cos(
                2 * math.pi * (day.timetuple().tm_yday - 15) / 365.25
            )
            lift = _HOLIDAY_LIFT if day in holiday_on else 1.0
            mean = level * _WEEKDAY[day.weekday()] * season * (1 + annual_growth) ** years * lift
            sales = round(mean * math.exp(float(noise[i]) - noise_sigma**2 / 2))
            covers = max(round(sales / (_SPEND_PER_HEAD_CENTS * math.exp(float(head_noise[i])))), 0)
            labour = round(180_000 + 0.22 * sales)
            rows.append(
                DailyRow(SYNTHETIC_VENUE, section, day, "open", _metrics(sales, covers, labour))
            )
    calendar = VenueCalendar(
        holidays={None: dict(holidays)},
        closed={None: frozenset(closed)},
    )
    return SyntheticDataset(
        DailyActuals(rows, ("net_sales_ex_gst_cents", "covers", "labour_cost_cents")),
        calendar,
        tuple(holidays),
        closed,
        missing,
    )


def _metrics(sales: int | None, covers: int | None, labour: int | None) -> dict[str, int | None]:
    return {"net_sales_ex_gst_cents": sales, "covers": covers, "labour_cost_cents": labour}


def calendar_rows(dataset: SyntheticDataset) -> list[tuple[str, str, str, str]]:
    """The dataset's calendar as CSV rows: venue_id, trading_day, kind, holiday_key."""
    rows = [("", d.isoformat(), "public_holiday", k) for d, k in dataset.holidays]
    rows += [("", d.isoformat(), "closed", "") for d in dataset.closed_days]
    return sorted(rows, key=lambda r: (r[1], r[2]))


ChallengerQuality = Literal["good", "bad"]


def synthetic_challenger(
    baseline_log: pl.DataFrame,
    actuals: DailyActuals,
    *,
    quality: ChallengerQuality,
    metric: str = "net_sales_ex_gst_cents",
    degrade_from: date | None = None,
    model_id: str | None = None,
) -> pl.DataFrame:
    """A SYNTHETIC challenger forecast log built from a baseline log (test oracle).

    * ``good``: halfway between the baseline's point and the actual, so its
      error is exactly half the baseline's (WAPE halves).
    * ``bad``: the baseline's point x 1.30 (biased high), clearly worse wherever
      the baseline is not already badly low.
    * ``degrade_from``: ``good`` for target days before this date and ``bad``
      from it onwards, to test rollback after a model goes wrong.

    Low/high are scaled with the point. Unforecastable rows stay unforecastable.
    """
    known = actuals.scored_actuals(metric).select(
        "venue_id", "section_id", "target_day", pl.col("actual").cast(pl.Float64)
    )
    df = baseline_log.join(known, on=["venue_id", "section_id", "target_day"], how="left")
    point = pl.col("point").cast(pl.Float64)
    good = (
        pl.when(pl.col("actual").is_not_null())
        .then(pl.col("actual") + 0.5 * (point - pl.col("actual")))
        .otherwise(point)
    )
    bad = point * 1.30
    new_point = good if quality == "good" else bad
    if degrade_from is not None:
        new_point = pl.when(pl.col("target_day") >= degrade_from).then(bad).otherwise(good)
    scale = pl.when(point > 0).then(new_point / point).otherwise(1.0)
    name = model_id or f"synthetic-{quality}-challenger"
    out = df.with_columns(
        point_new=new_point.round(0).cast(pl.Int64),
        scale=scale,
    ).with_columns(
        low=pl.min_horizontal(
            (pl.col("low").cast(pl.Float64) * pl.col("scale")).floor().cast(pl.Int64),
            pl.col("point_new"),
        ),
        high=pl.max_horizontal(
            (pl.col("high").cast(pl.Float64) * pl.col("scale")).ceil().cast(pl.Int64),
            pl.col("point_new"),
        ),
        point=pl.col("point_new"),
        model_id=pl.lit(name),
        model_version=pl.lit("synthetic"),
        rule=pl.when(pl.col("point_new").is_null())
        .then(pl.col("rule"))
        .otherwise(pl.lit("synthetic_oracle")),
    )
    return out.select(baseline_log.columns)
