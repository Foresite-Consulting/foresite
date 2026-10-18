"""Forecast log and accuracy tracking.

Plain English: every forecast we issue is written down. Once the day has
happened we compare it with what actually came in and keep score: how far off
we were on average (WAPE, the headline number), whether we tend to run high
or low (bias), and how often the actual landed inside the likely range
(coverage). We break that down by how far ahead the forecast was, by weekday,
by section and by rolling 4-week windows.

Forecast log format: CSV (UTF-8, one row per forecast). CSV rather than
Parquet because it needs no extra dependency, a person can open it, it
appends, and volumes are tiny (28 forecasts x sections x days: tens of
thousands of rows a year). In production the same columns become a Postgres
table. Until then: one writer per log. Appends take an advisory lock on
``<log>.lock`` and every write is atomic (temporary file, ``fsync``, rename). Columns, in order:

=================  ========================================================
issued_at          when it was issued, ISO 8601 with a UTC offset (``Z``)
model_id           e.g. ``baseline-swly-trend``
model_version      rules or model version (with config hash if non-default)
venue_id           venue
section_id         section
metric             e.g. ``net_sales_ex_gst_cents``
as_of              last trading day whose actuals were in when issued
target_day         trading day forecast
horizon_days       ``target_day - as_of``, 1-28
point              point estimate (whole units; cents ex GST for money)
low, high          likely range; ``0 <= low <= point <= high``
rule               provenance of the point (``unforecastable`` = no point)
interval_rule      provenance of the range (optional column)
interval_n         number of past errors behind the range (optional)
trend_factor       baseline trend factor (optional)
trend_rule         provenance of the trend factor (optional)
reference_days     ``;``-separated days the point was built from (optional)
=================  ========================================================

Metric definitions (for scored rows: forecastable, actual known, day open):

* **WAPE** = sum ``|actual - point|`` / sum ``actual``. Primary metric; robust
  to zero-sales days because it divides totals, not each day. Undefined
  (blank) when the actuals sum to 0.
* **MAPE** = mean of ``|actual - point| / actual`` over rows with
  ``actual > 0`` only (zero actuals are excluded and counted in ``mape_n``).
* **Bias** = sum ``(point - actual)`` / sum ``actual``; positive means we
  forecast too high.
* **Coverage** = share of rows with ``low <= actual <= high``.

If the same model issued the same target at the same horizon more than once,
only the latest issue counts, even when that latest issue is ``unforecastable``:
a later re-issue without a point retires the earlier point from scoring (the
model withdrew it). Closed and missing days are never scored.
Weeks run Monday to Sunday by target trading day.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Literal

import polars as pl

from foresite_forecast.csvio import (
    ID_PATTERN,
    CsvRow,
    exclusive_lock,
    parse_iso_date,
    read_csv,
    write_csv,
)
from foresite_forecast.errors import DataValidationError, ValidationIssue
from foresite_forecast.intervals import IntervalConfig
from foresite_forecast.model import Forecast
from foresite_forecast.schema import METRICS, DailyActuals

LOG_REQUIRED: tuple[str, ...] = (
    "issued_at",
    "model_id",
    "model_version",
    "venue_id",
    "section_id",
    "metric",
    "as_of",
    "target_day",
    "horizon_days",
    "point",
    "low",
    "high",
    "rule",
)
LOG_OPTIONAL: tuple[str, ...] = (
    "interval_rule",
    "interval_n",
    "trend_factor",
    "trend_rule",
    "reference_days",
)
LOG_COLUMNS: tuple[str, ...] = LOG_REQUIRED + LOG_OPTIONAL

LOG_SCHEMA: dict[str, pl.DataType] = {
    "issued_at": pl.Datetime("us", "UTC"),
    "model_id": pl.String(),
    "model_version": pl.String(),
    "venue_id": pl.String(),
    "section_id": pl.String(),
    "metric": pl.String(),
    "as_of": pl.Date(),
    "target_day": pl.Date(),
    "horizon_days": pl.Int64(),
    "point": pl.Int64(),
    "low": pl.Int64(),
    "high": pl.Int64(),
    "rule": pl.String(),
    "interval_rule": pl.String(),
    "interval_n": pl.Int64(),
    "trend_factor": pl.Float64(),
    "trend_rule": pl.String(),
    "reference_days": pl.String(),
}

#: Columns that identify one forecast target at one horizon for one model.
FORECAST_KEY: tuple[str, ...] = (
    "model_id",
    "venue_id",
    "section_id",
    "metric",
    "target_day",
    "horizon_days",
)
#: Every accuracy table is split by these.
GROUP_KEYS: tuple[str, ...] = ("model_id", "venue_id", "metric")

#: Model versions may also carry '+' (e.g. ``1.0.0+cfg.1a2b3c4d``).
VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$")


def _format_issued_at(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ").replace(".000000Z", "Z")


def _forecast_row(f: Forecast) -> tuple[object, ...]:
    return (
        _format_issued_at(f.issued_at),
        f.model_id,
        f.model_version,
        f.venue_id,
        f.section_id,
        f.metric,
        f.as_of,
        f.target_day,
        f.horizon_days,
        f.point,
        f.low,
        f.high,
        f.rule,
        f.interval_rule,
        f.interval_n,
        None if f.trend_factor is None else repr(f.trend_factor),
        f.trend_rule,
        ";".join(d.isoformat() for d in f.reference_days) or None,
    )


def forecasts_to_frame(forecasts: Iterable[Forecast]) -> pl.DataFrame:
    """Forecasts as a typed polars frame with :data:`LOG_COLUMNS`."""
    records = [
        (
            f.issued_at.astimezone(UTC),
            f.model_id,
            f.model_version,
            f.venue_id,
            f.section_id,
            f.metric,
            f.as_of,
            f.target_day,
            f.horizon_days,
            f.point,
            f.low,
            f.high,
            f.rule,
            f.interval_rule,
            f.interval_n,
            f.trend_factor,
            f.trend_rule,
            ";".join(d.isoformat() for d in f.reference_days) or None,
        )
        for f in forecasts
    ]
    return pl.DataFrame(records, schema=LOG_SCHEMA, orient="row")


def _typed[T](row: dict[str, object], column: str, kind: type[T]) -> T:
    value = row[column]
    if not isinstance(value, kind):
        raise TypeError(f"column {column} must be {kind.__name__}, got {type(value).__name__}")
    return value


def _optional[T](row: dict[str, object], column: str, kind: type[T]) -> T | None:
    return None if row.get(column) is None else _typed(row, column, kind)


def frame_to_forecasts(frame: pl.DataFrame) -> list[Forecast]:
    """Turn a log frame (as from :func:`forecasts_to_frame`) back into checked forecasts."""
    out: list[Forecast] = []
    for row in frame.select(LOG_COLUMNS).cast(pl.Schema(LOG_SCHEMA)).iter_rows(named=True):
        refs = _optional(row, "reference_days", str) or ""
        out.append(
            Forecast(
                issued_at=_typed(row, "issued_at", datetime),
                model_id=_typed(row, "model_id", str),
                model_version=_typed(row, "model_version", str),
                venue_id=_typed(row, "venue_id", str),
                section_id=_typed(row, "section_id", str),
                metric=_typed(row, "metric", str),
                as_of=_typed(row, "as_of", date),
                target_day=_typed(row, "target_day", date),
                horizon_days=_typed(row, "horizon_days", int),
                point=_optional(row, "point", int),
                low=_optional(row, "low", int),
                high=_optional(row, "high", int),
                rule=_typed(row, "rule", str),
                interval_rule=_optional(row, "interval_rule", str),
                interval_n=_optional(row, "interval_n", int) or 0,
                trend_factor=_optional(row, "trend_factor", float),
                trend_rule=_optional(row, "trend_rule", str),
                reference_days=tuple(date.fromisoformat(d) for d in refs.split(";") if d),
            )
        )
    return out


def write_forecast_log(path: Path, forecasts: Iterable[Forecast], *, append: bool = False) -> int:
    """Write forecasts to a CSV log. With ``append``, add to an existing log.

    Appending to an existing file first checks that it is a valid log, so a
    wrong path never gets a log tacked onto it. An append holds an advisory
    lock on ``<path>.lock`` for the whole read-modify-write (one writer per log
    until the Postgres table replaces the CSV); a second concurrent appender
    gets :class:`~foresite_forecast.csvio.LogLockedError`. Returns the rows written.
    """
    new = list(forecasts)
    if not append:
        write_csv(path, LOG_COLUMNS, [_forecast_row(f) for f in new])
        return len(new)
    with exclusive_lock(path):
        existing = read_forecast_log(path) if path.exists() else []
        write_csv(path, LOG_COLUMNS, [_forecast_row(f) for f in [*existing, *new]])
    return len(new)


def _parse_issued_at(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC)


def _parse_int(value: str | None) -> int | None | Literal[False]:
    """``None`` for blank, ``False`` for a bad value, otherwise the integer."""
    if value is None:
        return None
    if value.isascii() and value.isdigit() and len(value) <= 13:
        return int(value)
    return False


def _parse_float(value: str | None) -> float | None | Literal[False]:
    if value is None:
        return None
    try:
        parsed = float(value)
    except ValueError:
        return False
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        return False
    return parsed


def _row_to_forecast(row: CsvRow, issues: list[ValidationIssue]) -> Forecast | None:
    f = row.fields
    before = len(issues)

    def bad(column: str, message: str) -> None:
        issues.append(ValidationIssue(message, line=row.line, column=column, value=f.get(column)))

    issued_at = _parse_issued_at(f.get("issued_at"))
    if issued_at is None:
        bad(
            "issued_at",
            "must be an ISO 8601 date and time with a UTC offset, e.g. 2026-10-19T00:00:00Z",
        )
    ids: dict[str, str] = {}
    for column in ("model_id", "model_version", "venue_id", "section_id", "metric", "rule"):
        value = f.get(column)
        pattern = VERSION_PATTERN if column == "model_version" else ID_PATTERN
        if value is None or not pattern.match(value):
            allowed = "'_', '.', '+' or '-'" if column == "model_version" else "'_', '.' or '-'"
            bad(column, f"must be 1-64 letters, digits, {allowed}, starting with a letter or digit")
        else:
            ids[column] = value
    days: dict[str, date] = {}
    for column in ("as_of", "target_day"):
        value = f.get(column)
        parsed = parse_iso_date(value) if value is not None else None
        if parsed is None:
            bad(column, "must be a real date written YYYY-MM-DD")
        else:
            days[column] = parsed
    ints: dict[str, int | None] = {}
    for column in ("horizon_days", "point", "low", "high", "interval_n"):
        parsed_int = _parse_int(f.get(column))
        if parsed_int is False:
            bad(column, "must be a whole, non-negative number")
        else:
            ints[column] = parsed_int
    trend = _parse_float(f.get("trend_factor"))
    if trend is False:
        bad("trend_factor", "must be a number")
    refs: list[date] = []
    for part in (f.get("reference_days") or "").split(";"):
        if not part:
            continue
        parsed_ref = parse_iso_date(part)
        if parsed_ref is None:
            bad("reference_days", "must be YYYY-MM-DD dates separated by ';'")
            break
        refs.append(parsed_ref)
    for column in ("interval_rule", "trend_rule"):
        value = f.get(column)
        if value is not None and not ID_PATTERN.match(value):
            bad(column, "must be 1-64 letters, digits, '_', '.' or '-'")
    horizon = ints.get("horizon_days")
    if horizon is None and "horizon_days" in ints:
        bad("horizon_days", "is required")
    if len(issues) > before or issued_at is None or horizon is None:
        return None
    try:
        return Forecast(
            issued_at=issued_at,
            model_id=ids["model_id"],
            model_version=ids["model_version"],
            venue_id=ids["venue_id"],
            section_id=ids["section_id"],
            metric=ids["metric"],
            as_of=days["as_of"],
            target_day=days["target_day"],
            horizon_days=horizon,
            point=ints["point"],
            low=ints["low"],
            high=ints["high"],
            rule=ids["rule"],
            interval_rule=f.get("interval_rule"),
            interval_n=ints.get("interval_n") or 0,
            trend_factor=trend if trend is not False else None,
            trend_rule=f.get("trend_rule"),
            reference_days=tuple(refs),
        )
    except ValueError as exc:
        issues.append(ValidationIssue(str(exc), line=row.line))
        return None


def read_forecast_log(data: bytes | Path, *, source: str | None = None) -> list[Forecast]:
    """Read and validate a forecast log CSV. Every row must satisfy :class:`Forecast`."""
    name = source or (str(data) if isinstance(data, Path) else "forecast log")
    _, rows = read_csv(data, source=name, required=LOG_REQUIRED, optional=LOG_OPTIONAL)
    issues: list[ValidationIssue] = []
    out = [fc for row in rows if (fc := _row_to_forecast(row, issues)) is not None]
    if issues:
        raise DataValidationError(name, issues)
    return out


class ForecastLog:
    """In-memory forecast log: add forecasts as they are issued, then score them."""

    def __init__(self, forecasts: Iterable[Forecast] = ()) -> None:
        self._forecasts: list[Forecast] = list(forecasts)

    def add(self, forecasts: Iterable[Forecast]) -> None:
        """Record newly issued forecasts."""
        self._forecasts.extend(forecasts)

    @property
    def forecasts(self) -> tuple[Forecast, ...]:
        """Every forecast recorded, in the order added."""
        return tuple(self._forecasts)

    def __len__(self) -> int:
        return len(self._forecasts)

    def to_frame(self) -> pl.DataFrame:
        """The log as a typed frame."""
        return forecasts_to_frame(self._forecasts)

    @classmethod
    def read(cls, path: Path) -> ForecastLog:
        """Load a CSV log."""
        return cls(read_forecast_log(path))

    def write(self, path: Path) -> None:
        """Write the whole log as CSV (replacing the file)."""
        write_forecast_log(path, self._forecasts)

    def score(self, actuals: DailyActuals) -> pl.DataFrame:
        """Score against actuals; see :func:`score`."""
        return score(self.to_frame(), actuals)


def latest_issues(log: pl.DataFrame) -> pl.DataFrame:
    """Keep only the latest issue per model x target x horizon."""
    # Stable sort: for identical issue times the row later in the log wins.
    return log.sort("issued_at", maintain_order=True).unique(
        subset=list(FORECAST_KEY), keep="last", maintain_order=True
    )


def _bucket_label_expr(config: IntervalConfig) -> pl.Expr:
    return pl.coalesce(
        [
            pl.when(pl.col("horizon_days").is_between(lo, hi)).then(pl.lit(f"{lo}-{hi}"))
            for lo, hi in config.horizon_buckets
        ]
    )


def score(
    log: pl.DataFrame, actuals: DailyActuals, *, interval_config: IntervalConfig | None = None
) -> pl.DataFrame:
    """Join forecasts with known actuals.

    Applies :func:`latest_issues` first and only then drops rows without a
    point, so a later ``unforecastable`` re-issue supersedes (retires) an
    earlier point. Keeps rows whose target day is open with a known actual.
    Adds ``actual``, ``error`` (point - actual), ``abs_error``, ``in_range``,
    ``weekday`` (1 = Monday), ``week_start`` (Monday) and ``horizon_bucket``.
    """
    cfg = interval_config or IntervalConfig()
    forecastable = latest_issues(log).filter(pl.col("point").is_not_null())
    metrics = [m for m in METRICS if m in actuals.metrics]
    known = pl.concat([actuals.scored_actuals(m) for m in metrics])
    joined = forecastable.join(
        known, on=["venue_id", "section_id", "metric", "target_day"], how="inner"
    )
    return joined.with_columns(
        error=pl.col("point") - pl.col("actual"),
        abs_error=(pl.col("point") - pl.col("actual")).abs(),
        in_range=(pl.col("low") <= pl.col("actual")) & (pl.col("actual") <= pl.col("high")),
        weekday=pl.col("target_day").dt.weekday(),
        week_start=pl.col("target_day").dt.truncate("1w"),
        horizon_bucket=_bucket_label_expr(cfg),
    ).sort([*FORECAST_KEY])


def _components() -> list[pl.Expr]:
    actual = pl.col("actual").cast(pl.Float64)
    return [
        pl.len().alias("n"),
        actual.sum().alias("actual_sum"),
        pl.col("abs_error").cast(pl.Float64).sum().alias("abs_error_sum"),
        pl.col("error").cast(pl.Float64).sum().alias("error_sum"),
        pl.col("in_range").cast(pl.Int64).sum().alias("in_range_n"),
        pl.when(actual > 0)
        .then(pl.col("abs_error") / actual)
        .otherwise(None)
        .sum()
        .alias("ape_sum"),
        (actual > 0).cast(pl.Int64).sum().alias("mape_n"),
    ]


def _finish(df: pl.DataFrame) -> pl.DataFrame:
    has_actual = pl.col("actual_sum") > 0
    return df.with_columns(
        wape=pl.when(has_actual)
        .then(pl.col("abs_error_sum") / pl.col("actual_sum"))
        .otherwise(None),
        mape=pl.when(pl.col("mape_n") > 0)
        .then(pl.col("ape_sum") / pl.col("mape_n"))
        .otherwise(None),
        bias=pl.when(has_actual).then(pl.col("error_sum") / pl.col("actual_sum")).otherwise(None),
        coverage=pl.col("in_range_n") / pl.col("n"),
    ).drop("ape_sum")


def metrics(scored: pl.DataFrame, by: Sequence[str] = ()) -> pl.DataFrame:
    """WAPE, MAPE, bias and coverage per :data:`GROUP_KEYS` plus ``by``."""
    keys = [*GROUP_KEYS, *by]
    return _finish(scored.group_by(keys).agg(_components()).sort(keys))


def rolling_weeks(scored: pl.DataFrame, weeks: int = 4) -> pl.DataFrame:
    """Metrics over rolling windows of ``weeks`` calendar weeks ending each week.

    ``week_start`` is the last week in the window; ``weeks_with_data`` says how
    many of the window's weeks had scored forecasts.
    """
    weekly = scored.group_by([*GROUP_KEYS, "week_start"]).agg(_components())
    other = weekly.rename({c: f"{c}_o" for c in weekly.columns if c not in GROUP_KEYS})
    joined = (
        weekly.select([*GROUP_KEYS, "week_start"])
        .join(other, on=list(GROUP_KEYS))
        .filter(
            (pl.col("week_start_o") <= pl.col("week_start"))
            & (pl.col("week_start_o") > pl.col("week_start") - timedelta(weeks=weeks))
        )
    )
    sums = ["n", "actual_sum", "abs_error_sum", "error_sum", "in_range_n", "ape_sum", "mape_n"]
    rolled = joined.group_by([*GROUP_KEYS, "week_start"]).agg(
        [pl.col(f"{c}_o").sum().alias(c) for c in sums] + [pl.len().alias("weeks_with_data")]
    )
    return _finish(rolled).sort([*GROUP_KEYS, "week_start"])


@dataclass(frozen=True)
class AccuracyReport:
    """Accuracy tables, each split by model, venue and metric."""

    overall: pl.DataFrame
    by_horizon: pl.DataFrame
    by_horizon_bucket: pl.DataFrame
    by_weekday: pl.DataFrame
    by_section: pl.DataFrame
    by_week: pl.DataFrame
    rolling_4_weeks: pl.DataFrame

    def tables(self) -> dict[str, pl.DataFrame]:
        """Every table by name."""
        return {
            "overall": self.overall,
            "by_horizon": self.by_horizon,
            "by_horizon_bucket": self.by_horizon_bucket,
            "by_weekday": self.by_weekday,
            "by_section": self.by_section,
            "by_week": self.by_week,
            "rolling_4_weeks": self.rolling_4_weeks,
        }


def accuracy_report(scored: pl.DataFrame) -> AccuracyReport:
    """Every accuracy breakdown for scored forecasts."""
    return AccuracyReport(
        overall=metrics(scored),
        by_horizon=metrics(scored, ["horizon_days"]),
        by_horizon_bucket=metrics(scored, ["horizon_bucket"]).sort(
            [*GROUP_KEYS, pl.col("horizon_bucket").str.split("-").list.first().cast(pl.Int64)]
        ),
        by_weekday=metrics(scored, ["weekday"]),
        by_section=metrics(scored, ["section_id"]),
        by_week=metrics(scored, ["week_start"]),
        rolling_4_weeks=rolling_weeks(scored, 4),
    )


SummaryBasis = Literal["live", "backtest"]


@dataclass(frozen=True)
class AccuracySummary:
    """'Accuracy to date' for a UI tile, in plain words plus the numbers behind them."""

    status: Literal["ok", "insufficient_history"]
    basis: SummaryBasis
    horizon_days: int
    weeks: int
    scored: int
    in_range: int
    typical_error_pct: int | None
    bias_pct: int | None
    headline: str
    detail: str
    disclaimer: str = "Forecasts are estimates, not guarantees."

    def as_dict(self) -> dict[str, object]:
        """JSON-ready form."""
        return {
            "status": self.status,
            "basis": self.basis,
            "horizon_days": self.horizon_days,
            "weeks": self.weeks,
            "scored": self.scored,
            "in_range": self.in_range,
            "typical_error_pct": self.typical_error_pct,
            "bias_pct": self.bias_pct,
            "headline": self.headline,
            "detail": self.detail,
            "disclaimer": self.disclaimer,
        }


def _ahead(horizon: int) -> str:
    if horizon == 1:
        return "a day ahead"
    if horizon == 7:
        return "a week ahead"
    return f"{horizon} days ahead"


def summarise_accuracy(
    scored: pl.DataFrame,
    *,
    as_of: date,
    model_id: str,
    venue_id: str,
    metric: str,
    section_id: str | None = None,
    horizon_days: int = 7,
    weeks: int = 10,
    min_scored: int = 28,
    basis: SummaryBasis = "live",
) -> AccuracySummary:
    """Accuracy to date for one model x venue x metric (optionally one section).

    Uses forecasts made ``horizon_days`` ahead whose target day falls in the
    ``weeks`` x 7 days ending on ``as_of``. Fewer than ``min_scored`` scored
    forecasts gives ``insufficient_history`` rather than a misleading number.
    """
    window_start = as_of - timedelta(days=7 * weeks - 1)
    rows = scored.filter(
        (pl.col("model_id") == model_id)
        & (pl.col("venue_id") == venue_id)
        & (pl.col("metric") == metric)
        & (pl.col("horizon_days") == horizon_days)
        & pl.col("target_day").is_between(window_start, as_of)
    )
    if section_id is not None:
        rows = rows.filter(pl.col("section_id") == section_id)
    n = rows.height
    in_range = int(rows["in_range"].sum()) if n else 0
    if n < min_scored:
        return AccuracySummary(
            status="insufficient_history",
            basis=basis,
            horizon_days=horizon_days,
            weeks=weeks,
            scored=n,
            in_range=in_range,
            typical_error_pct=None,
            bias_pct=None,
            headline="Not enough history yet to show accuracy.",
            detail=(
                f"Accuracy shows once {min_scored} forecasts can be checked against actuals "
                f"({n} so far)."
            ),
        )
    actual_sum = float(rows["actual"].sum())
    abs_sum = float(rows["abs_error"].sum())
    err_sum = float(rows["error"].sum())
    wape = round(100 * abs_sum / actual_sum) if actual_sum > 0 else None
    bias = round(100 * err_sum / actual_sum) if actual_sum > 0 else None
    error_text = (
        f"Typical error {wape}% ({_ahead(horizon_days)})."
        if wape is not None
        else "Typical error can't be worked out because actuals were zero."
    )
    bias_text = ""
    if bias is not None and abs(bias) >= 5:
        bias_text = f" Tends to run {'high' if bias > 0 else 'low'} by {abs(bias)}%."
    source = " Based on a backtest, not live forecasts yet." if basis == "backtest" else ""
    return AccuracySummary(
        status="ok",
        basis=basis,
        horizon_days=horizon_days,
        weeks=weeks,
        scored=n,
        in_range=in_range,
        typical_error_pct=wape,
        bias_pct=bias,
        headline=f"In the likely range {in_range} of {n} times in the last {weeks} weeks.",
        detail=f"{error_text}{bias_text}{source}",
    )
