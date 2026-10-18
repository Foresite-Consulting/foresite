"""Likely range (low/high) from a model's own past errors.

Plain English: we look at how far off the forecast has been in the past, for
the same weekday and a similar distance ahead, and use that spread to draw the
range. With the default 10th-90th percentiles, roughly 8 in 10 actuals should
land inside the range. It is a likely range, not a guarantee.

Technical: each past forecast with a known actual gives a ratio
``actual / point`` (only when ``point > 0``). For a forecast issued on
``as_of`` we pool ratios from forecasts issued in the ``lookback_days`` before
``as_of`` whose target day is on or before ``as_of`` (so nothing from the
future leaks in). Pools, most specific first:

1. ``empirical_weekday_horizon``: same target weekday and same horizon bucket
   (default buckets 1-7, 8-14, 15-28 days ahead), if it has at least
   ``min_residuals`` ratios;
2. ``empirical_horizon``: same horizon bucket, any weekday, same minimum;
3. ``fallback_fixed_width``: a deliberately wide fixed band
   (default 0.70x-1.30x the point) while history is short.

``low = point * min(q_low ratio, 1)`` and ``high = point * max(q_high ratio, 1)``.
Clamping at 1 guarantees ``low <= point <= high`` even where the model has
been biased; it can only widen the range, never narrow it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from foresite_forecast.model import MAX_HORIZON_DAYS, MIN_HORIZON_DAYS

INTERVAL_EMPIRICAL_CELL = "empirical_weekday_horizon"
INTERVAL_EMPIRICAL_BUCKET = "empirical_horizon"
INTERVAL_FALLBACK = "fallback_fixed_width"
#: Planned closure: forecast is exactly 0 with a 0-0 range.
INTERVAL_CLOSED = "closed"
#: Point of 0 on an open day: ratios can't scale 0, so the range runs from 0 to
#: the highest recent same-weekday actual.
INTERVAL_ZERO_POINT = "zero_point_recent_max"


@dataclass(frozen=True)
class IntervalConfig:
    """Settings for the likely range. Defaults are documented in ADR 0004."""

    q_low: float = 0.10
    q_high: float = 0.90
    lookback_days: int = 364
    min_residuals: int = 30
    horizon_buckets: tuple[tuple[int, int], ...] = ((1, 7), (8, 14), (15, 28))
    fallback_low_ratio: float = 0.70
    fallback_high_ratio: float = 1.30

    def __post_init__(self) -> None:
        if not 0.0 < self.q_low < self.q_high < 1.0:
            raise ValueError("need 0 < q_low < q_high < 1")
        if self.lookback_days < 7:
            raise ValueError("lookback_days must be at least 7")
        if self.min_residuals < 1:
            raise ValueError("min_residuals must be at least 1")
        if not 0.0 <= self.fallback_low_ratio <= 1.0 <= self.fallback_high_ratio:
            raise ValueError("need 0 <= fallback_low_ratio <= 1 <= fallback_high_ratio")
        expected = MIN_HORIZON_DAYS
        for lo, hi in self.horizon_buckets:
            if lo != expected or hi < lo:
                raise ValueError(
                    f"horizon_buckets must be contiguous and cover {MIN_HORIZON_DAYS}-"
                    f"{MAX_HORIZON_DAYS} without overlap"
                )
            expected = hi + 1
        if expected != MAX_HORIZON_DAYS + 1:
            raise ValueError(
                f"horizon_buckets must cover {MIN_HORIZON_DAYS}-{MAX_HORIZON_DAYS} without overlap"
            )

    def bucket_of(self, horizon: int) -> int:
        """Index of the horizon bucket that contains ``horizon``."""
        for i, (lo, hi) in enumerate(self.horizon_buckets):
            if lo <= horizon <= hi:
                return i
        raise ValueError(f"horizon {horizon} is outside {MIN_HORIZON_DAYS}-{MAX_HORIZON_DAYS}")


@dataclass(frozen=True)
class Residuals:
    """Past forecast errors as ratios. Days are ``date.toordinal()`` integers.

    ``weekdays`` are the target day's weekday (Monday = 0).
    """

    origins: npt.NDArray[np.int64]
    targets: npt.NDArray[np.int64]
    horizons: npt.NDArray[np.int64]
    weekdays: npt.NDArray[np.int64]
    ratios: npt.NDArray[np.float64]

    def __post_init__(self) -> None:
        n = len(self.ratios)
        for arr in (self.origins, self.targets, self.horizons, self.weekdays):
            if len(arr) != n:
                raise ValueError("residual arrays must have the same length")
        if n and (
            int(self.horizons.min()) < MIN_HORIZON_DAYS
            or int(self.horizons.max()) > MAX_HORIZON_DAYS
        ):
            raise ValueError(f"residual horizons must be {MIN_HORIZON_DAYS}-{MAX_HORIZON_DAYS}")

    @classmethod
    def empty(cls) -> Residuals:
        """No residuals."""
        i = np.zeros(0, dtype=np.int64)
        return cls(i, i, i, i, np.zeros(0, dtype=np.float64))

    @classmethod
    def concat(cls, parts: Sequence[Residuals]) -> Residuals:
        """Join several residual sets."""
        if not parts:
            return cls.empty()
        return cls(
            np.concatenate([p.origins for p in parts]),
            np.concatenate([p.targets for p in parts]),
            np.concatenate([p.horizons for p in parts]),
            np.concatenate([p.weekdays for p in parts]),
            np.concatenate([p.ratios for p in parts]),
        )


@dataclass(frozen=True)
class RatioBand:
    """Multipliers for the range around a point, and where they came from."""

    low_ratio: float
    high_ratio: float
    rule: str
    n: int

    def apply(self, point: float) -> tuple[float, float]:
        """``(low, high)`` for ``point``; always ``low <= point <= high``."""
        return point * self.low_ratio, point * self.high_ratio


class IntervalCalibrator:
    """Ratio bands for forecasts issued on one ``as_of`` day (an ordinal)."""

    def __init__(self, residuals: Residuals, as_of_ordinal: int, config: IntervalConfig) -> None:
        self.config = config
        mask = (
            (residuals.origins < as_of_ordinal)
            & (residuals.origins >= as_of_ordinal - config.lookback_days)
            & (residuals.targets <= as_of_ordinal)
            & np.isfinite(residuals.ratios)
        )
        ratios = residuals.ratios[mask]
        # Lookup table: horizon -> bucket index (index 0 unused).
        lut = np.array(
            [0] + [config.bucket_of(h) for h in range(MIN_HORIZON_DAYS, MAX_HORIZON_DAYS + 1)],
            dtype=np.int64,
        )
        buckets = lut[residuals.horizons[mask]]
        weekdays = residuals.weekdays[mask]
        self._cells: dict[tuple[int, int], RatioBand] = {}
        self._buckets: dict[int, RatioBand] = {}
        for b in range(len(config.horizon_buckets)):
            in_bucket = buckets == b
            pool = ratios[in_bucket]
            if len(pool) >= config.min_residuals:
                self._buckets[b] = self._band(pool, INTERVAL_EMPIRICAL_BUCKET)
            for wd in range(7):
                cell = ratios[in_bucket & (weekdays == wd)]
                if len(cell) >= config.min_residuals:
                    self._cells[(b, wd)] = self._band(cell, INTERVAL_EMPIRICAL_CELL)

    def _band(self, pool: npt.NDArray[np.float64], rule: str) -> RatioBand:
        lo, hi = np.quantile(pool, [self.config.q_low, self.config.q_high], method="linear")
        return RatioBand(min(float(lo), 1.0), max(float(hi), 1.0), rule, len(pool))

    def band(self, horizon: int, weekday: int) -> RatioBand:
        """The band for a target ``horizon`` days ahead on ``weekday`` (Monday = 0)."""
        b = self.config.bucket_of(horizon)
        found = self._cells.get((b, weekday)) or self._buckets.get(b)
        if found is not None:
            return found
        return RatioBand(
            self.config.fallback_low_ratio, self.config.fallback_high_ratio, INTERVAL_FALLBACK, 0
        )
