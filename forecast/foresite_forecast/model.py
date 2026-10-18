"""The forecast record every model produces, and the interface a model implements.

The baseline (``baseline.py``) implements :class:`ForecastModel` now. A later
LightGBM model implements the same interface, so the forecast log, accuracy
tracking, champion/challenger selection and rollback work unchanged.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Protocol, runtime_checkable

from foresite_forecast.schema import DailyActuals, VenueCalendar

MIN_HORIZON_DAYS = 1
MAX_HORIZON_DAYS = 28

#: ``rule`` value for a target the model could not forecast (no point, no range).
UNFORECASTABLE = "unforecastable"


@dataclass(frozen=True)
class Forecast:
    """One forecast: a point estimate and a likely range for one target trading day.

    Invariants (checked on construction):

    * ``horizon_days == (target_day - as_of).days`` and is 1-28;
    * ``rule`` (provenance: which rule produced the point) is always set;
    * either ``point``, ``low`` and ``high`` are all set with
      ``0 <= low <= point <= high``, or all three are ``None`` and ``rule`` is
      :data:`UNFORECASTABLE`.

    Values are in the metric's unit (cents for money, ex GST). A forecast is an
    estimate, never a guarantee; the range is where the actual is *likely* to
    fall, not a promise.
    """

    issued_at: datetime
    model_id: str
    model_version: str
    venue_id: str
    section_id: str
    metric: str
    as_of: date
    target_day: date
    horizon_days: int
    point: int | None
    low: int | None
    high: int | None
    rule: str
    interval_rule: str | None = None
    interval_n: int = 0
    trend_factor: float | None = None
    trend_rule: str | None = None
    reference_days: tuple[date, ...] = ()

    def __post_init__(self) -> None:
        if self.issued_at.tzinfo is None:
            raise ValueError("issued_at must be timezone-aware (UTC)")
        if not MIN_HORIZON_DAYS <= self.horizon_days <= MAX_HORIZON_DAYS:
            raise ValueError(
                f"horizon_days must be {MIN_HORIZON_DAYS}-{MAX_HORIZON_DAYS}, "
                f"got {self.horizon_days}"
            )
        if (self.target_day - self.as_of).days != self.horizon_days:
            raise ValueError("horizon_days must equal target_day - as_of")
        if not self.rule:
            raise ValueError("rule (provenance) must be set")
        values = (self.point, self.low, self.high)
        if all(v is None for v in values):
            if self.rule != UNFORECASTABLE:
                raise ValueError("a forecast without a point must have rule 'unforecastable'")
            return
        if self.point is None or self.low is None or self.high is None:
            raise ValueError("point, low and high must all be set or all be None")
        if not 0 <= self.low <= self.point <= self.high:
            raise ValueError(
                f"need 0 <= low <= point <= high, got {self.low}, {self.point}, {self.high}"
            )
        if self.rule == UNFORECASTABLE:
            raise ValueError("an 'unforecastable' forecast must not have a point")
        if not self.interval_rule:
            raise ValueError("interval_rule must be set when there is a range")

    @property
    def forecastable(self) -> bool:
        """True if the forecast has a point and a range."""
        return self.point is not None


@runtime_checkable
class ForecastModel(Protocol):
    """What every forecast model provides.

    ``forecast`` must use only actuals on or before ``as_of`` (the last trading
    day whose actuals are complete), must be deterministic for the same inputs,
    and must return one :class:`Forecast` per (series, horizon), including
    ``unforecastable`` ones, so gaps are visible rather than silently missing.
    """

    @property
    def model_id(self) -> str: ...

    @property
    def model_version(self) -> str: ...

    def forecast(
        self,
        actuals: DailyActuals,
        as_of: date,
        *,
        metric: str,
        horizons: Sequence[int],
        issued_at: datetime,
        calendar: VenueCalendar | None = None,
    ) -> list[Forecast]: ...
