"""Data contract for the forecast engine: actuals and the venue calendar.

Input is already keyed by **trading day** (open to close, in the venue's local
time; the trading-day model in ``packages/core`` decides which day a sale
belongs to) and **section**. This module checks the data and turns it into the
dense per-series arrays the models use.

Daily actuals CSV (one row per venue x section x trading day)
    ``venue_id``, ``section_id``, ``trading_day`` (``YYYY-MM-DD``), optional
    ``status`` (``open`` | ``closed`` | ``missing``; blank means ``open``),
    ``net_sales_ex_gst_cents`` (required column), optional ``covers`` and
    ``labour_cost_cents``.

Rules (all enforced, all problems reported together with line numbers):

* identifiers are 1-64 of ``A-Z a-z 0-9 _ . -`` and start with a letter or digit;
* one row per venue x section x trading day (no duplicates);
* every series is **contiguous** from its first to its last trading day. A day
  with no data must still have a row, with ``status=missing`` (we don't know)
  or ``status=closed`` (the venue or section did not trade). Silent gaps are
  rejected so a missing upload can never look like a zero-sales day;
* metric values are whole, non-negative numbers (cents for money, ex GST);
* ``open`` rows need ``net_sales_ex_gst_cents``; ``covers`` and
  ``labour_cost_cents`` may be blank on an open row (unknown for that metric);
* ``closed`` rows have blank or zero metrics; ``missing`` rows have blank metrics.

Calendar CSV (optional)
    ``trading_day``, ``kind`` (``public_holiday`` | ``closed``), optional
    ``venue_id`` (blank = every venue) and ``holiday_key`` (required for a
    public holiday, e.g. ``christmas_day``; the same key every year so a
    holiday can be matched with last year's, even when its date moves).

Interval actuals CSV (optional, e.g. 15-minute sales)
    ``venue_id``, ``section_id``, ``trading_day``, ``interval_start``
    (local ``YYYY-MM-DDTHH:MM``, on the trading day or the next calendar day
    because a trading day can run past midnight), ``interval_minutes`` (15, 30
    or 60, start aligned to it) and the same metric columns. Aggregated to
    daily actuals with :func:`daily_actuals_from_intervals`.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Literal

import numpy as np
import numpy.typing as npt
import polars as pl

from foresite_forecast.csvio import (
    CsvRow,
    check_count,
    check_date,
    check_id,
    read_csv,
    write_csv,
)
from foresite_forecast.errors import DataValidationError, ValidationIssue

DayStatus = Literal["open", "closed", "missing"]
DAY_STATUSES: tuple[DayStatus, ...] = ("open", "closed", "missing")

#: Status codes used in the dense arrays.
OPEN: int = 0
CLOSED: int = 1
MISSING: int = 2
_STATUS_CODE: dict[DayStatus, int] = {"open": OPEN, "closed": CLOSED, "missing": MISSING}

KEY_COLUMNS: tuple[str, ...] = ("venue_id", "section_id", "trading_day")
REQUIRED_METRICS: tuple[str, ...] = ("net_sales_ex_gst_cents",)
OPTIONAL_METRICS: tuple[str, ...] = ("covers", "labour_cost_cents")
METRICS: tuple[str, ...] = REQUIRED_METRICS + OPTIONAL_METRICS

CalendarKind = Literal["public_holiday", "closed"]
CALENDAR_KINDS: tuple[CalendarKind, ...] = ("public_holiday", "closed")
HOLIDAY_KEY_PATTERN = re.compile(r"^[a-z0-9_]{1,64}$")

ALLOWED_INTERVAL_MINUTES: tuple[int, ...] = (15, 30, 60)
_INTERVAL_START_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")


@dataclass(frozen=True)
class DailyRow:
    """One validated row of daily actuals."""

    venue_id: str
    section_id: str
    trading_day: date
    status: DayStatus
    metrics: Mapping[str, int | None]


@dataclass(frozen=True)
class Series:
    """One metric for one venue x section as dense arrays over consecutive days.

    ``values[i]`` is the actual for ``start + i`` days, or NaN when it is not
    known (status ``missing``, status ``closed``, or blank for this metric).
    ``status[i]`` is :data:`OPEN`, :data:`CLOSED` or :data:`MISSING`.
    """

    venue_id: str
    section_id: str
    metric: str
    start: date
    values: npt.NDArray[np.float64]
    status: npt.NDArray[np.int8]

    def __post_init__(self) -> None:
        if self.values.shape != self.status.shape or self.values.ndim != 1:
            raise ValueError("values and status must be 1-D arrays of the same length")

    @property
    def end(self) -> date:
        """Last trading day covered (inclusive)."""
        return self.start + timedelta(days=len(self.values) - 1)

    def offset(self, day: date) -> int:
        """Index of ``day`` in the arrays (may be out of range)."""
        return (day - self.start).days

    def status_on(self, day: date) -> int:
        """Status of ``day``; days outside the series are :data:`MISSING`."""
        i = self.offset(day)
        if 0 <= i < len(self.status):
            return int(self.status[i])
        return MISSING

    def value_on(self, day: date) -> float | None:
        """The actual for ``day`` if the day was open and the value is known."""
        i = self.offset(day)
        if 0 <= i < len(self.values) and self.status[i] == OPEN:
            v = float(self.values[i])
            if not math.isnan(v):
                return v
        return None


@dataclass(frozen=True)
class VenueCalendar:
    """Public holidays and planned closures per venue.

    Entries with no venue apply to every venue. A venue-specific holiday key
    overrides an all-venue one on the same day.
    """

    holidays: Mapping[str | None, Mapping[date, str]] = field(default_factory=dict)
    closed: Mapping[str | None, frozenset[date]] = field(default_factory=dict)

    @classmethod
    def empty(cls) -> VenueCalendar:
        """A calendar with no holidays and no planned closures."""
        return cls()

    def holiday_key(self, venue_id: str, day: date) -> str | None:
        """The holiday key on ``day`` for this venue, or ``None``."""
        own = self.holidays.get(venue_id, {})
        if day in own:
            return own[day]
        return self.holidays.get(None, {}).get(day)

    def is_closed(self, venue_id: str, day: date) -> bool:
        """True if the calendar says the venue is closed on ``day``."""
        return day in self.closed.get(venue_id, frozenset()) or day in self.closed.get(
            None, frozenset()
        )

    def occurrences(self, venue_id: str, key: str) -> list[date]:
        """Every day with holiday ``key`` for this venue, sorted."""
        days = {d for d in self.holidays.get(None, {}) if self.holiday_key(venue_id, d) == key}
        days |= {d for d, k in self.holidays.get(venue_id, {}).items() if k == key}
        return sorted(days)


class DailyActuals:
    """Validated daily actuals. Build with :func:`read_daily_actuals` or
    :func:`daily_actuals_from_rows`; don't construct directly."""

    def __init__(self, rows: Sequence[DailyRow], metrics: Sequence[str]) -> None:
        self._rows = sorted(rows, key=lambda r: (r.venue_id, r.section_id, r.trading_day))
        self.metrics: tuple[str, ...] = tuple(metrics)
        by_key: dict[tuple[str, str], list[DailyRow]] = {}
        for row in self._rows:
            by_key.setdefault((row.venue_id, row.section_id), []).append(row)
        self._by_key = by_key

    @property
    def rows(self) -> tuple[DailyRow, ...]:
        """All rows, sorted by venue, section and trading day."""
        return tuple(self._rows)

    def series_keys(self) -> list[tuple[str, str]]:
        """Every (venue_id, section_id) pair, sorted."""
        return sorted(self._by_key)

    def last_day(self) -> date:
        """The latest trading day in the data."""
        if not self._rows:
            raise ValueError("no actuals")
        return max(r.trading_day for r in self._rows)

    def series(self, venue_id: str, section_id: str, metric: str) -> Series:
        """Dense arrays for one metric of one venue x section."""
        if metric not in self.metrics:
            raise KeyError(f"metric '{metric}' is not in these actuals ({', '.join(self.metrics)})")
        rows = self._by_key.get((venue_id, section_id))
        if rows is None:
            raise KeyError(f"no actuals for venue '{venue_id}', section '{section_id}'")
        values = np.full(len(rows), np.nan, dtype=np.float64)
        status = np.empty(len(rows), dtype=np.int8)
        for i, row in enumerate(rows):
            status[i] = _STATUS_CODE[row.status]
            v = row.metrics.get(metric)
            if row.status == "open" and v is not None:
                values[i] = float(v)
        return Series(venue_id, section_id, metric, rows[0].trading_day, values, status)

    def scored_actuals(self, metric: str) -> pl.DataFrame:
        """Known actuals for scoring forecasts: open days with a value only.

        Columns: venue_id, section_id, metric, target_day, actual (Int64).
        Closed and missing days are left out, so they are never scored.
        """
        if metric not in self.metrics:
            raise KeyError(f"metric '{metric}' is not in these actuals ({', '.join(self.metrics)})")
        records = [
            (r.venue_id, r.section_id, metric, r.trading_day, r.metrics.get(metric))
            for r in self._rows
            if r.status == "open" and r.metrics.get(metric) is not None
        ]
        return pl.DataFrame(
            records,
            schema={
                "venue_id": pl.String,
                "section_id": pl.String,
                "metric": pl.String,
                "target_day": pl.Date,
                "actual": pl.Int64,
            },
            orient="row",
        )


def _validate_daily_rows(
    rows: Sequence[CsvRow], columns: Sequence[str], source: str
) -> tuple[list[DailyRow], list[str]]:
    issues: list[ValidationIssue] = []
    metrics = [m for m in METRICS if m in columns]
    parsed: list[DailyRow] = []
    first_line: dict[tuple[str, str, date], int] = {}

    for row in rows:
        before = len(issues)
        venue = check_id(row, "venue_id", issues)
        section = check_id(row, "section_id", issues)
        day = check_date(row, "trading_day", issues)
        raw_status = row.fields.get("status") or "open"
        if raw_status not in DAY_STATUSES:
            issues.append(
                ValidationIssue(
                    "must be open, closed or missing (blank means open)",
                    line=row.line,
                    column="status",
                    value=raw_status,
                )
            )
        values = {m: check_count(row, m, issues) for m in metrics}
        if len(issues) > before or venue is None or section is None or day is None:
            continue
        status: DayStatus = (
            "open" if raw_status == "open" else ("closed" if raw_status == "closed" else "missing")
        )
        if status == "open":
            for m in REQUIRED_METRICS:
                if values[m] is None:
                    issues.append(
                        ValidationIssue(
                            "is required on an open day (use status=missing if it is unknown)",
                            line=row.line,
                            column=m,
                        )
                    )
        elif status == "closed":
            for m in metrics:
                if values[m] not in (None, 0):
                    issues.append(
                        ValidationIssue(
                            "must be blank or 0 on a closed day",
                            line=row.line,
                            column=m,
                            value=str(values[m]),
                        )
                    )
        else:
            for m in metrics:
                if values[m] is not None:
                    issues.append(
                        ValidationIssue(
                            "must be blank on a missing day",
                            line=row.line,
                            column=m,
                            value=str(values[m]),
                        )
                    )
        key = (venue, section, day)
        if key in first_line:
            issues.append(
                ValidationIssue(
                    f"duplicate of line {first_line[key]} "
                    f"(venue {venue}, section {section}, trading day {day.isoformat()})",
                    line=row.line,
                )
            )
            continue
        first_line[key] = row.line
        parsed.append(DailyRow(venue, section, day, status, values))

    if not issues:
        issues.extend(_contiguity_issues(parsed))
    if not parsed and not issues:
        issues.append(ValidationIssue("no data rows"))
    if issues:
        raise DataValidationError(source, issues)
    return parsed, metrics


def _contiguity_issues(rows: Sequence[DailyRow]) -> list[ValidationIssue]:
    days: dict[tuple[str, str], set[date]] = {}
    for row in rows:
        days.setdefault((row.venue_id, row.section_id), set()).add(row.trading_day)
    issues: list[ValidationIssue] = []
    for (venue, section), present in sorted(days.items()):
        first, last = min(present), max(present)
        expected = (last - first).days + 1
        if len(present) == expected:
            continue
        absent = [
            first + timedelta(days=i)
            for i in range(expected)
            if first + timedelta(days=i) not in present
        ]
        shown = ", ".join(d.isoformat() for d in absent[:5])
        more = f" and {len(absent) - 5} more" if len(absent) > 5 else ""
        issues.append(
            ValidationIssue(
                f"venue {venue}, section {section}: {len(absent)} trading day(s) between "
                f"{first.isoformat()} and {last.isoformat()} have no row ({shown}{more}). "
                "Add a row with status=missing (unknown) or status=closed (did not trade)"
            )
        )
    return issues


def read_daily_actuals(data: bytes | Path, *, source: str | None = None) -> DailyActuals:
    """Read and validate a daily actuals CSV file (or its bytes)."""
    name = source or (str(data) if isinstance(data, Path) else "daily actuals")
    header, rows = read_csv(
        data,
        source=name,
        required=(*KEY_COLUMNS, *REQUIRED_METRICS),
        optional=("status", *OPTIONAL_METRICS),
    )
    parsed, metrics = _validate_daily_rows(rows, header, name)
    return DailyActuals(parsed, metrics)


def _stringify(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        # bool is an int subclass; never accept True/False as a count.
        return str(value)
    if isinstance(value, date | int | str):
        return value.isoformat() if isinstance(value, date) else str(value)
    return repr(value)


def daily_actuals_from_rows(
    records: Iterable[Mapping[str, object]], *, source: str = "daily actuals"
) -> DailyActuals:
    """Validate in-memory records (dicts with the CSV column names) as daily actuals.

    Values may be ``str``, ``int``, ``date`` or ``None``; they pass through
    exactly the same checks as a CSV file. "Line" numbers in errors count the
    first record as line 2, as if a header were line 1.
    """
    materialised = list(records)
    columns: list[str] = []
    for record in materialised:
        for name in record:
            if name not in columns:
                columns.append(name)
    allowed = {*KEY_COLUMNS, "status", *METRICS}
    issues = [ValidationIssue("unknown column", column=c) for c in columns if c not in allowed]
    issues += [
        ValidationIssue("required column is missing", column=c)
        for c in (*KEY_COLUMNS, *REQUIRED_METRICS)
        if c not in columns
    ]
    if issues:
        raise DataValidationError(source, issues)
    rows = [
        CsvRow(i + 2, {c: _stringify(record.get(c)) for c in columns})
        for i, record in enumerate(materialised)
    ]
    parsed, metrics = _validate_daily_rows(rows, columns, source)
    return DailyActuals(parsed, metrics)


def read_calendar(data: bytes | Path, *, source: str | None = None) -> VenueCalendar:
    """Read and validate a venue calendar CSV file (or its bytes)."""
    name = source or (str(data) if isinstance(data, Path) else "calendar")
    _, rows = read_csv(
        data, source=name, required=("trading_day", "kind"), optional=("venue_id", "holiday_key")
    )
    issues: list[ValidationIssue] = []
    holidays: dict[str | None, dict[date, str]] = {}
    closed: dict[str | None, set[date]] = {}
    seen: dict[tuple[str | None, date, str], int] = {}
    for row in rows:
        before = len(issues)
        venue = check_id(row, "venue_id", issues) if row.fields.get("venue_id") else None
        day = check_date(row, "trading_day", issues)
        kind = row.fields.get("kind")
        key = row.fields.get("holiday_key")
        if kind not in CALENDAR_KINDS:
            issues.append(
                ValidationIssue(
                    "must be public_holiday or closed", line=row.line, column="kind", value=kind
                )
            )
        elif kind == "public_holiday":
            if key is None:
                issues.append(
                    ValidationIssue(
                        "is required for a public holiday (e.g. christmas_day)",
                        line=row.line,
                        column="holiday_key",
                    )
                )
            elif not HOLIDAY_KEY_PATTERN.match(key):
                issues.append(
                    ValidationIssue(
                        "must be 1-64 lower-case letters, digits or '_'",
                        line=row.line,
                        column="holiday_key",
                        value=key,
                    )
                )
        elif key is not None:
            issues.append(
                ValidationIssue(
                    "must be blank for a closed day", line=row.line, column="holiday_key", value=key
                )
            )
        if len(issues) > before or day is None or kind is None:
            continue
        dup_key = (venue, day, kind)
        if dup_key in seen:
            issues.append(ValidationIssue(f"duplicate of line {seen[dup_key]}", line=row.line))
            continue
        seen[dup_key] = row.line
        if kind == "public_holiday" and key is not None:
            holidays.setdefault(venue, {})[day] = key
        else:
            closed.setdefault(venue, set()).add(day)
    if issues:
        raise DataValidationError(name, issues)
    return VenueCalendar(
        holidays={v: dict(d) for v, d in holidays.items()},
        closed={v: frozenset(d) for v, d in closed.items()},
    )


@dataclass(frozen=True)
class IntervalRow:
    """One validated interval of actuals (e.g. 15 minutes of sales)."""

    venue_id: str
    section_id: str
    trading_day: date
    interval_start: datetime
    interval_minutes: int
    metrics: Mapping[str, int | None]


def read_interval_actuals(
    data: bytes | Path, *, source: str | None = None
) -> tuple[list[IntervalRow], tuple[str, ...]]:
    """Read and validate an interval actuals CSV. Returns the rows and the metric columns."""
    name = source or (str(data) if isinstance(data, Path) else "interval actuals")
    header, rows = read_csv(
        data,
        source=name,
        required=(*KEY_COLUMNS, "interval_start", "interval_minutes", *REQUIRED_METRICS),
        optional=OPTIONAL_METRICS,
    )
    metrics = tuple(m for m in METRICS if m in header)
    issues: list[ValidationIssue] = []
    parsed: list[IntervalRow] = []
    seen: dict[tuple[str, str, datetime], int] = {}
    for row in rows:
        before = len(issues)
        venue = check_id(row, "venue_id", issues)
        section = check_id(row, "section_id", issues)
        day = check_date(row, "trading_day", issues)
        minutes = check_count(row, "interval_minutes", issues)
        raw_start = row.fields.get("interval_start")
        start: datetime | None = None
        if raw_start is None or not _INTERVAL_START_PATTERN.match(raw_start):
            issues.append(
                ValidationIssue(
                    "must be a local time written YYYY-MM-DDTHH:MM",
                    line=row.line,
                    column="interval_start",
                    value=raw_start,
                )
            )
        else:
            try:
                start = datetime.fromisoformat(raw_start)
            except ValueError:
                issues.append(
                    ValidationIssue(
                        "is not a real date and time",
                        line=row.line,
                        column="interval_start",
                        value=raw_start,
                    )
                )
        values = {m: check_count(row, m, issues) for m in metrics}
        if minutes is not None and minutes not in ALLOWED_INTERVAL_MINUTES:
            issues.append(
                ValidationIssue(
                    "must be 15, 30 or 60",
                    line=row.line,
                    column="interval_minutes",
                    value=str(minutes),
                )
            )
        if values.get("net_sales_ex_gst_cents") is None and len(issues) == before:
            issues.append(
                ValidationIssue("is required", line=row.line, column="net_sales_ex_gst_cents")
            )
        if (
            len(issues) > before
            or venue is None
            or section is None
            or day is None
            or start is None
            or minutes is None
        ):
            continue
        if start.date() not in (day, day + timedelta(days=1)):
            issues.append(
                ValidationIssue(
                    "must fall on the trading day or the next calendar day (after midnight)",
                    line=row.line,
                    column="interval_start",
                    value=raw_start,
                )
            )
            continue
        if (start.hour * 60 + start.minute) % minutes != 0:
            issues.append(
                ValidationIssue(
                    f"must start on a {minutes}-minute boundary",
                    line=row.line,
                    column="interval_start",
                    value=raw_start,
                )
            )
            continue
        dup = (venue, section, start)
        if dup in seen:
            issues.append(ValidationIssue(f"duplicate of line {seen[dup]}", line=row.line))
            continue
        seen[dup] = row.line
        parsed.append(IntervalRow(venue, section, day, start, minutes, values))
    if not parsed and not issues:
        issues.append(ValidationIssue("no data rows"))
    if issues:
        raise DataValidationError(name, issues)
    return parsed, metrics


def daily_actuals_from_intervals(
    intervals: Sequence[IntervalRow], metrics: Sequence[str]
) -> DailyActuals:
    """Sum intervals into daily actuals.

    A trading day with at least one interval is ``open``. Days between a
    series' first and last trading day with no intervals become explicit
    ``missing`` rows: an absent upload is never treated as zero sales. Mark
    known closures with the calendar. An optional metric is blank for a day
    if any of its intervals has it blank.
    """
    totals: dict[tuple[str, str, date], dict[str, int | None]] = {}
    for iv in intervals:
        key = (iv.venue_id, iv.section_id, iv.trading_day)
        acc = totals.setdefault(key, dict.fromkeys(metrics, 0))
        for m in metrics:
            v = iv.metrics.get(m)
            current = acc[m]
            acc[m] = None if v is None or current is None else current + v
    by_series: dict[tuple[str, str], list[date]] = {}
    for venue, section, day in totals:
        by_series.setdefault((venue, section), []).append(day)
    rows: list[DailyRow] = []
    for (venue, section), days in by_series.items():
        first, last = min(days), max(days)
        for i in range((last - first).days + 1):
            day = first + timedelta(days=i)
            found = totals.get((venue, section, day))
            if found is None:
                rows.append(DailyRow(venue, section, day, "missing", dict.fromkeys(metrics)))
            else:
                rows.append(DailyRow(venue, section, day, "open", found))
    return DailyActuals(rows, metrics)


def write_daily_actuals(path: Path, actuals: DailyActuals) -> None:
    """Write daily actuals as CSV in the contract's column order."""
    header = (*KEY_COLUMNS, "status", *actuals.metrics)
    write_csv(
        path,
        header,
        (
            (
                r.venue_id,
                r.section_id,
                r.trading_day,
                r.status,
                *(r.metrics.get(m) for m in actuals.metrics),
            )
            for r in actuals.rows
        ),
    )
