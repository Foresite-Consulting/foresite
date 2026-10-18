"""The benchmark forecast: same weekday last year, adjusted for trend.

Plain English: to forecast a Saturday, take the Saturday 52 weeks earlier and
scale it by how the venue has been tracking lately compared with a year ago
(the last 8 weeks against the same 8 weeks last year). If last year's day is
unusable (a holiday, closed, or no data), fall back to a sensible substitute
and say so. Every number records the rule that produced it.

Technical definitions (see also ADR 0004). ``as_of`` is the last trading day
whose actuals are complete; the target is ``t = as_of + h`` with ``h`` in 1-28.
Only actuals on or before ``as_of`` are used.

*Usable day*: status ``open``, value known, not a calendar public holiday and
not a calendar closed day. (*Usable holiday day*: the same but holidays allowed.)

*Trend factor* (computed once per ``as_of``): pair each day ``d`` in the
window ``[as_of - 55, as_of]`` (8 x 7 days, so every weekday counts equally)
with ``d - 364``. Keep pairs where both days are usable. Then

* fewer than ``trend_min_pairs`` (28) pairs: factor 1.0, ``trend_insufficient_history``;
* both sums 0: factor 1.0, ``trend_zero_base``; earlier sum 0, recent sum > 0:
  factor = cap, ``trend_capped``;
* otherwise ``sum(recent) / sum(year earlier)`` clamped to ``[trend_floor, trend_cap]``
  (default 0.5-2.0): ``trend_window``, or ``trend_capped`` if it was clamped.

*Point*, first rule that applies:

1. ``closed_calendar``: the calendar says the venue is closed on ``t``: 0, range 0-0.
2. ``holiday_last_year``: ``t`` is a public holiday with key K and K's previous
   occurrence ``d`` (330-400 days before ``t``, nearest to 364) is a usable
   holiday day: ``value(d) x trend``. Matches Easter to Easter even though its
   date moves; matches Christmas to Christmas although the weekday differs.
3. ``same_weekday_last_year``: ``r = t - 364`` is usable: ``value(r) x trend``.
4. ``same_weekday_last_year_neighbours``: mean of the usable days among
   ``r +/- 7`` and ``r +/- 14`` (needs at least 2) ``x trend``.
5. ``recent_same_weekday_median``: median of the usable days among the 8 most
   recent same-weekday days on or before ``as_of`` (needs at least 3). No trend
   factor: these days already reflect the current level.
6. ``unforecastable``: no point and no range; the reason is visible, not hidden.

*Leap years*: the shift is always 364 days (exactly 52 weeks) so a Saturday is
compared with a Saturday. The calendar date drifts by 1 day a year (2 after
29 February); date-fixed events are handled by holiday matching instead.

Values are rounded to whole units (cents) at the end: the point half up, the
low down and the high up, so ``low <= point <= high`` always holds.
"""

from __future__ import annotations

import hashlib
import math
import statistics
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta

import numpy as np

from foresite_forecast.intervals import (
    INTERVAL_CLOSED,
    INTERVAL_ZERO_POINT,
    IntervalCalibrator,
    IntervalConfig,
    Residuals,
)
from foresite_forecast.model import (
    MAX_HORIZON_DAYS,
    MIN_HORIZON_DAYS,
    UNFORECASTABLE,
    Forecast,
)
from foresite_forecast.schema import OPEN, DailyActuals, Series, VenueCalendar

BASELINE_MODEL_ID = "baseline-swly-trend"
#: Bump when a rule changes, so logged forecasts say which rules made them.
BASELINE_RULES_VERSION = "1.0.0"

#: 52 weeks: keeps the weekday. Deliberately not 365/366 (see module docstring).
LAST_YEAR_SHIFT_DAYS = 364
#: Search window for last year's occurrence of a holiday, in days before the target.
HOLIDAY_SEARCH_MIN_DAYS = 330
HOLIDAY_SEARCH_MAX_DAYS = 400

RULE_CLOSED = "closed_calendar"
RULE_HOLIDAY = "holiday_last_year"
RULE_SWLY = "same_weekday_last_year"
RULE_NEIGHBOURS = "same_weekday_last_year_neighbours"
RULE_RECENT = "recent_same_weekday_median"
POINT_RULES: tuple[str, ...] = (
    RULE_CLOSED,
    RULE_HOLIDAY,
    RULE_SWLY,
    RULE_NEIGHBOURS,
    RULE_RECENT,
    UNFORECASTABLE,
)

TREND_WINDOW = "trend_window"
TREND_CAPPED = "trend_capped"
TREND_INSUFFICIENT = "trend_insufficient_history"
TREND_ZERO_BASE = "trend_zero_base"

ALL_HORIZONS: tuple[int, ...] = tuple(range(MIN_HORIZON_DAYS, MAX_HORIZON_DAYS + 1))


@dataclass(frozen=True)
class BaselineConfig:
    """Settings for the baseline. Defaults are documented in ADR 0004."""

    trend_window_days: int = 56
    trend_min_pairs: int = 28
    trend_floor: float = 0.5
    trend_cap: float = 2.0
    neighbour_weeks: int = 2
    neighbour_min_count: int = 2
    recent_weeks: int = 8
    recent_min_count: int = 3
    intervals: IntervalConfig = field(default_factory=IntervalConfig)

    def __post_init__(self) -> None:
        if self.trend_window_days < 7 or self.trend_window_days % 7:
            raise ValueError("trend_window_days must be a positive multiple of 7")
        if not 1 <= self.trend_min_pairs <= self.trend_window_days:
            raise ValueError("trend_min_pairs must be between 1 and trend_window_days")
        if not 0.0 < self.trend_floor <= 1.0 <= self.trend_cap:
            raise ValueError("need 0 < trend_floor <= 1 <= trend_cap")
        if (
            self.neighbour_weeks < 1
            or not 1 <= self.neighbour_min_count <= 2 * self.neighbour_weeks
        ):
            raise ValueError("need neighbour_weeks >= 1 and 1 <= neighbour_min_count <= 2 x weeks")
        if self.recent_weeks < 1 or not 1 <= self.recent_min_count <= self.recent_weeks:
            raise ValueError("need recent_weeks >= 1 and 1 <= recent_min_count <= recent_weeks")


@dataclass(frozen=True)
class Trend:
    """Trend factor for one ``as_of`` day and the rule that produced it."""

    factor: float
    rule: str
    pairs: int


@dataclass(frozen=True)
class PointEstimate:
    """Unrounded point for one target, before the range is added."""

    value: float | None
    rule: str
    reference_days: tuple[date, ...]
    trend: Trend | None


def _round_half_up(x: float) -> int:
    return math.floor(x + 0.5)


class SeriesBaseline:
    """The baseline for one venue x section x metric.

    Results are memoised per ``as_of``, so a rolling backtest over many days
    and a single forecast on one day run exactly the same code and give
    identical numbers.
    """

    def __init__(self, series: Series, calendar: VenueCalendar, config: BaselineConfig) -> None:
        self.series = series
        self.calendar = calendar
        self.config = config
        n = len(series.values)
        venue = series.venue_id
        days = [series.start + timedelta(days=i) for i in range(n)]
        known = (series.status == OPEN) & ~np.isnan(series.values)
        closed = np.array([calendar.is_closed(venue, d) for d in days], dtype=bool)
        holiday = np.array([calendar.holiday_key(venue, d) is not None for d in days], dtype=bool)
        self._usable_holiday = known & ~closed
        self._usable = self._usable_holiday & ~holiday
        self._trend: dict[date, Trend] = {}
        self._points: dict[tuple[date, int], PointEstimate] = {}
        self._residuals: dict[date, Residuals] = {}

    # -- lookups -----------------------------------------------------------------

    def _value(self, day: date, as_of: date, *, holiday_ok: bool = False) -> float | None:
        """The value of ``day`` if it is usable and on or before ``as_of``."""
        if day > as_of:
            return None
        i = self.series.offset(day)
        if not 0 <= i < len(self.series.values):
            return None
        mask = self._usable_holiday if holiday_ok else self._usable
        if not mask[i]:
            return None
        return float(self.series.values[i])

    def _recent_same_weekday(self, target: date, as_of: date) -> list[tuple[date, float]]:
        """Usable values among the most recent ``recent_weeks`` same-weekday days <= as_of."""
        found: list[tuple[date, float]] = []
        day = target - timedelta(days=7)
        while day > as_of:
            day -= timedelta(days=7)
        for _ in range(self.config.recent_weeks):
            v = self._value(day, as_of)
            if v is not None:
                found.append((day, v))
            day -= timedelta(days=7)
        return found

    # -- trend -------------------------------------------------------------------

    def trend(self, as_of: date) -> Trend:
        """The trend factor for forecasts issued on ``as_of``."""
        cached = self._trend.get(as_of)
        if cached is not None:
            return cached
        cfg = self.config
        recent_sum = 0.0
        earlier_sum = 0.0
        pairs = 0
        for i in range(cfg.trend_window_days):
            day = as_of - timedelta(days=i)
            now = self._value(day, as_of)
            then = self._value(day - timedelta(days=LAST_YEAR_SHIFT_DAYS), as_of)
            if now is None or then is None:
                continue
            pairs += 1
            recent_sum += now
            earlier_sum += then
        if pairs < cfg.trend_min_pairs:
            result = Trend(1.0, TREND_INSUFFICIENT, pairs)
        elif earlier_sum <= 0.0:
            result = (
                Trend(1.0, TREND_ZERO_BASE, pairs)
                if recent_sum <= 0.0
                else Trend(cfg.trend_cap, TREND_CAPPED, pairs)
            )
        else:
            ratio = recent_sum / earlier_sum
            clamped = min(max(ratio, cfg.trend_floor), cfg.trend_cap)
            result = Trend(clamped, TREND_CAPPED if clamped != ratio else TREND_WINDOW, pairs)
        self._trend[as_of] = result
        return result

    # -- point -------------------------------------------------------------------

    def point(self, as_of: date, horizon: int) -> PointEstimate:
        """The unrounded point for ``as_of + horizon`` and its provenance."""
        key = (as_of, horizon)
        cached = self._points.get(key)
        if cached is not None:
            return cached
        result = self._point(as_of, horizon)
        self._points[key] = result
        return result

    def _point(self, as_of: date, horizon: int) -> PointEstimate:
        cfg = self.config
        venue = self.series.venue_id
        target = as_of + timedelta(days=horizon)
        if self.calendar.is_closed(venue, target):
            return PointEstimate(0.0, RULE_CLOSED, (), None)

        holiday = self.calendar.holiday_key(venue, target)
        if holiday is not None:
            candidates = [
                d
                for d in self.calendar.occurrences(venue, holiday)
                if HOLIDAY_SEARCH_MIN_DAYS <= (target - d).days <= HOLIDAY_SEARCH_MAX_DAYS
            ]
            candidates.sort(key=lambda d: (abs((target - d).days - LAST_YEAR_SHIFT_DAYS), d))
            for d in candidates[:1]:
                v = self._value(d, as_of, holiday_ok=True)
                if v is not None:
                    trend = self.trend(as_of)
                    return PointEstimate(v * trend.factor, RULE_HOLIDAY, (d,), trend)

        ref = target - timedelta(days=LAST_YEAR_SHIFT_DAYS)
        v = self._value(ref, as_of)
        if v is not None:
            trend = self.trend(as_of)
            return PointEstimate(v * trend.factor, RULE_SWLY, (ref,), trend)

        neighbours: list[tuple[date, float]] = []
        for k in range(1, cfg.neighbour_weeks + 1):
            for d in (ref - timedelta(days=7 * k), ref + timedelta(days=7 * k)):
                nv = self._value(d, as_of)
                if nv is not None:
                    neighbours.append((d, nv))
        if len(neighbours) >= cfg.neighbour_min_count:
            trend = self.trend(as_of)
            mean = sum(v for _, v in neighbours) / len(neighbours)
            days = tuple(sorted(d for d, _ in neighbours))
            return PointEstimate(mean * trend.factor, RULE_NEIGHBOURS, days, trend)

        recent = self._recent_same_weekday(target, as_of)
        if len(recent) >= cfg.recent_min_count:
            median = statistics.median(v for _, v in recent)
            days = tuple(sorted(d for d, _ in recent))
            return PointEstimate(median, RULE_RECENT, days, None)

        return PointEstimate(None, UNFORECASTABLE, (), None)

    # -- residuals and range -----------------------------------------------------

    def _residuals_from(self, origin: date) -> Residuals:
        """Ratios ``actual / point`` for every horizon of a forecast issued on ``origin``."""
        cached = self._residuals.get(origin)
        if cached is not None:
            return cached
        origins: list[int] = []
        targets: list[int] = []
        horizons: list[int] = []
        weekdays: list[int] = []
        ratios: list[float] = []
        for h in ALL_HORIZONS:
            est = self.point(origin, h)
            if est.value is None or est.value <= 0.0 or est.rule == RULE_CLOSED:
                continue
            target = origin + timedelta(days=h)
            actual = self.series.value_on(target)
            if actual is None or self.calendar.is_closed(self.series.venue_id, target):
                continue
            origins.append(origin.toordinal())
            targets.append(target.toordinal())
            horizons.append(h)
            weekdays.append(target.weekday())
            ratios.append(actual / est.value)
        result = Residuals(
            np.array(origins, dtype=np.int64),
            np.array(targets, dtype=np.int64),
            np.array(horizons, dtype=np.int64),
            np.array(weekdays, dtype=np.int64),
            np.array(ratios, dtype=np.float64),
        )
        self._residuals[origin] = result
        return result

    def calibrator(self, as_of: date) -> IntervalCalibrator:
        """Interval bands for forecasts issued on ``as_of``, from earlier forecasts only."""
        lookback = self.config.intervals.lookback_days
        first = max(as_of - timedelta(days=lookback), self.series.start)
        parts = [
            self._residuals_from(first + timedelta(days=i)) for i in range((as_of - first).days)
        ]
        return IntervalCalibrator(Residuals.concat(parts), as_of.toordinal(), self.config.intervals)

    def forecasts(
        self,
        as_of: date,
        horizons: Sequence[int],
        *,
        issued_at: datetime,
        model_id: str,
        model_version: str,
    ) -> list[Forecast]:
        """Rounded forecasts with likely ranges for ``as_of + h`` for each ``h``."""
        calibrator = self.calibrator(as_of)
        s = self.series
        out: list[Forecast] = []
        for h in horizons:
            est = self.point(as_of, h)
            target = as_of + timedelta(days=h)

            def make(
                point: int | None,
                low: int | None,
                high: int | None,
                interval_rule: str | None,
                interval_n: int,
                *,
                est: PointEstimate = est,
                target: date = target,
                h: int = h,
            ) -> Forecast:
                return Forecast(
                    issued_at=issued_at,
                    model_id=model_id,
                    model_version=model_version,
                    venue_id=s.venue_id,
                    section_id=s.section_id,
                    metric=s.metric,
                    as_of=as_of,
                    target_day=target,
                    horizon_days=h,
                    point=point,
                    low=low,
                    high=high,
                    rule=est.rule,
                    interval_rule=interval_rule,
                    interval_n=interval_n,
                    trend_factor=round(est.trend.factor, 6) if est.trend else None,
                    trend_rule=est.trend.rule if est.trend else None,
                    reference_days=est.reference_days,
                )

            if est.value is None:
                out.append(make(None, None, None, None, 0))
            elif est.rule == RULE_CLOSED:
                out.append(make(0, 0, 0, INTERVAL_CLOSED, 0))
            elif est.value <= 0.0:
                # A ratio can't scale a zero point: range is 0 to the highest recent actual.
                recent = self._recent_same_weekday(target, as_of)
                top = math.ceil(max((v for _, v in recent), default=0.0))
                out.append(make(0, 0, top, INTERVAL_ZERO_POINT, len(recent)))
            else:
                point = _round_half_up(est.value)
                band = calibrator.band(h, target.weekday())
                low_f, high_f = band.apply(est.value)
                low = min(max(math.floor(low_f), 0), point)
                high = max(math.ceil(high_f), point)
                out.append(make(point, low, high, band.rule, band.n))
        return out


def _model_version(config: BaselineConfig) -> str:
    if config == BaselineConfig():
        return BASELINE_RULES_VERSION
    digest = hashlib.sha256(repr(config).encode()).hexdigest()[:8]
    return f"{BASELINE_RULES_VERSION}+cfg.{digest}"


def _check_horizons(horizons: Sequence[int]) -> tuple[int, ...]:
    hs = tuple(horizons)
    if not hs:
        raise ValueError("at least one horizon is needed")
    if len(set(hs)) != len(hs):
        raise ValueError("horizons must not repeat")
    for h in hs:
        if isinstance(h, bool) or not MIN_HORIZON_DAYS <= h <= MAX_HORIZON_DAYS:
            raise ValueError(
                f"horizons must be whole days from {MIN_HORIZON_DAYS} to {MAX_HORIZON_DAYS}, "
                f"got {h!r}"
            )
    return hs


def nominal_issued_at(as_of: date) -> datetime:
    """Issue time used for backtests: midnight UTC at the start of the day after ``as_of``."""
    return datetime.combine(as_of + timedelta(days=1), time(0), tzinfo=UTC)


class BaselineModel:
    """Same weekday last year x trend, with an empirical likely range.

    Implements :class:`foresite_forecast.model.ForecastModel`.
    """

    def __init__(self, config: BaselineConfig | None = None) -> None:
        self.config = config or BaselineConfig()
        self._version = _model_version(self.config)

    @property
    def model_id(self) -> str:
        """Stable identifier written to the forecast log."""
        return BASELINE_MODEL_ID

    @property
    def model_version(self) -> str:
        """Rules version, plus a config hash when settings differ from the defaults."""
        return self._version

    def _engines(
        self, actuals: DailyActuals, metric: str, calendar: VenueCalendar | None
    ) -> list[SeriesBaseline]:
        cal = calendar or VenueCalendar.empty()
        return [
            SeriesBaseline(actuals.series(venue, section, metric), cal, self.config)
            for venue, section in actuals.series_keys()
        ]

    def forecast(
        self,
        actuals: DailyActuals,
        as_of: date,
        *,
        metric: str,
        horizons: Sequence[int] = ALL_HORIZONS,
        issued_at: datetime,
        calendar: VenueCalendar | None = None,
    ) -> list[Forecast]:
        """Forecasts for every series in ``actuals``, issued after ``as_of`` closed."""
        hs = _check_horizons(horizons)
        last = actuals.last_day()
        if as_of > last:
            raise ValueError(
                f"as-of day {as_of.isoformat()} is after the last trading day in the actuals "
                f"({last.isoformat()}); forecasts can only be issued once a day's actuals are in"
            )
        out: list[Forecast] = []
        for engine in self._engines(actuals, metric, calendar):
            out.extend(
                engine.forecasts(
                    as_of,
                    hs,
                    issued_at=issued_at,
                    model_id=self.model_id,
                    model_version=self.model_version,
                )
            )
        return out

    def backtest(
        self,
        actuals: DailyActuals,
        origins: Sequence[date],
        *,
        metric: str,
        horizons: Sequence[int] = ALL_HORIZONS,
        calendar: VenueCalendar | None = None,
    ) -> list[Forecast]:
        """Forecasts as they would have been issued on each origin day.

        Identical to calling :meth:`forecast` on each origin with
        ``issued_at = nominal_issued_at(origin)``, but shares work between days.
        """
        hs = _check_horizons(horizons)
        last = actuals.last_day()
        if any(o > last for o in origins):
            raise ValueError(f"every origin must be on or before {last.isoformat()}")
        out: list[Forecast] = []
        for engine in self._engines(actuals, metric, calendar):
            for origin in sorted(set(origins)):
                out.extend(
                    engine.forecasts(
                        origin,
                        hs,
                        issued_at=nominal_issued_at(origin),
                        model_id=self.model_id,
                        model_version=self.model_version,
                    )
                )
        return out


__all__ = [
    "ALL_HORIZONS",
    "BASELINE_MODEL_ID",
    "BASELINE_RULES_VERSION",
    "LAST_YEAR_SHIFT_DAYS",
    "POINT_RULES",
    "BaselineConfig",
    "BaselineModel",
    "PointEstimate",
    "SeriesBaseline",
    "Trend",
    "nominal_issued_at",
]
