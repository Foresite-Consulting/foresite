"""Champion/challenger: automatic rollback to the baseline, and the Phase 2 gate.

Plain English: each week we check whether the live model (the challenger)
beat the simple baseline. If it was worse four weeks running, we switch back
to the baseline and raise an alert. We never switch on a single bad week, on
weeks with too little data, or on weeks that haven't finished. Before Phase 2
sign-off, a model must beat the baseline on weeks it was not trained on.

Exact rules:

*Week*: Monday to Sunday by target trading day. A week is **complete** when
its Sunday is on or before the evaluation day (default: the last trading day
in the actuals).

*Weekly comparison* (per venue x metric, all sections and horizons pooled):
forecasts are matched on venue, section, metric, target day and horizon; only
pairs where both models gave a point and the actual is known (open day) count,
after keeping each model's latest issue. A week is **evaluable** when it has
at least ``min_pairs_per_week`` matched pairs (default 7), the matched pairs
are at least ``min_match_fraction`` (default 90%) of the baseline's scored
forecasts that week (so a challenger can't look good by skipping hard days),
and actuals sum to more than 0. Each model's WAPE is computed on the matched
pairs. The challenger is **worse** when
``challenger_wape > baseline_wape x (1 + worse_margin)`` (default margin 0,
so a tie is *not* worse).

*Rollback decision*, over the last ``rollback_weeks`` (default 4) complete
calendar weeks:

* any evaluable week where the challenger was not worse: ``keep``;
* all of them evaluable and worse: ``rollback_to_baseline``, serve the
  baseline, emit an alert;
* otherwise (a missing or thin week, no not-worse week): ``insufficient_data``;
  keep serving the challenger, but don't count the run as clean.

A missing week can therefore never trigger a rollback, and it can never hide
a good week. Rollback is one-way: going back to the challenger needs a person
and a fresh pass of the Phase 2 gate.

*Phase 2 gate* (:func:`beats_baseline`): on the hold-out weeks (default the
last 8 complete weeks), every week must be evaluable, the challenger's pooled
WAPE must be lower than the baseline's by at least
``min_relative_improvement`` (default 0: strictly lower), and the challenger
must be strictly better in at least N of the M weeks, N =
``ceil(min_weeks_better_fraction x M)`` (default 0.75, so 6 of 8).
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Literal

import polars as pl

from foresite_forecast.accuracy import score
from foresite_forecast.schema import DailyActuals

MATCH_KEYS: tuple[str, ...] = ("venue_id", "section_id", "metric", "target_day", "horizon_days")

WeekVerdict = Literal["worse", "not_worse", "insufficient"]
Decision = Literal["keep", "rollback_to_baseline", "insufficient_data"]
GateStatus = Literal["pass", "fail", "insufficient_data"]


@dataclass(frozen=True)
class SelectionConfig:
    """Thresholds for the weekly comparison and the rollback rule."""

    rollback_weeks: int = 4
    worse_margin: float = 0.0
    min_pairs_per_week: int = 7
    min_match_fraction: float = 0.9

    def __post_init__(self) -> None:
        if self.rollback_weeks < 1:
            raise ValueError("rollback_weeks must be at least 1")
        if self.worse_margin < 0:
            raise ValueError("worse_margin must not be negative")
        if self.min_pairs_per_week < 1:
            raise ValueError("min_pairs_per_week must be at least 1")
        if not 0.0 < self.min_match_fraction <= 1.0:
            raise ValueError("min_match_fraction must be in (0, 1]")


@dataclass(frozen=True)
class GateConfig:
    """Thresholds for the Phase 2 gate."""

    holdout_weeks: int = 8
    min_weeks_better_fraction: float = 0.75
    min_weeks_better: int | None = None
    min_relative_improvement: float = 0.0
    selection: SelectionConfig = field(default_factory=SelectionConfig)

    def __post_init__(self) -> None:
        if self.holdout_weeks < 1:
            raise ValueError("holdout_weeks must be at least 1")
        if not 0.0 < self.min_weeks_better_fraction <= 1.0:
            raise ValueError("min_weeks_better_fraction must be in (0, 1]")
        if self.min_weeks_better is not None and self.min_weeks_better < 1:
            raise ValueError("min_weeks_better must be at least 1")
        if not 0.0 <= self.min_relative_improvement < 1.0:
            raise ValueError("min_relative_improvement must be in [0, 1)")

    def weeks_required(self, m: int) -> int:
        """N: weeks the challenger must win out of ``m`` hold-out weeks."""
        if self.min_weeks_better is not None:
            return min(self.min_weeks_better, m)
        return max(1, math.ceil(self.min_weeks_better_fraction * m - 1e-9))


@dataclass(frozen=True)
class WeekComparison:
    """One week, challenger against baseline."""

    week_start: date
    pairs: int
    baseline_scored: int
    challenger_wape: float | None
    baseline_wape: float | None
    verdict: WeekVerdict
    note: str

    @property
    def week_end(self) -> date:
        """The Sunday that ends the week."""
        return self.week_start + timedelta(days=6)

    def as_dict(self) -> dict[str, object]:
        """JSON-ready form."""
        return {
            "week_start": self.week_start.isoformat(),
            "week_end": self.week_end.isoformat(),
            "pairs": self.pairs,
            "baseline_scored": self.baseline_scored,
            "challenger_wape": self.challenger_wape,
            "baseline_wape": self.baseline_wape,
            "verdict": self.verdict,
            "note": self.note,
        }


def format_day(day: date) -> str:
    """``18 Oct 2026``."""
    return f"{day.day} {day:%b %Y}"


@dataclass(frozen=True)
class RollbackAlert:
    """Alert raised when the live model is rolled back to the baseline.

    No personal data: venue, metric, model ids, weeks and WAPEs only.
    ``alert_id`` is deterministic, so re-running the check never raises a
    duplicate alert for the same run of weeks.
    """

    alert_id: str
    venue_id: str
    metric: str
    challenger_model_id: str
    baseline_model_id: str
    weeks: tuple[WeekComparison, ...]
    message: str
    kind: str = "forecast_rollback"
    severity: str = "warning"

    def as_dict(self) -> dict[str, object]:
        """JSON-ready form."""
        return {
            "alert_id": self.alert_id,
            "kind": self.kind,
            "severity": self.severity,
            "venue_id": self.venue_id,
            "metric": self.metric,
            "challenger_model_id": self.challenger_model_id,
            "baseline_model_id": self.baseline_model_id,
            "weeks": [w.as_dict() for w in self.weeks],
            "message": self.message,
        }


@dataclass(frozen=True)
class RollbackDecision:
    """The weekly rollback check for one venue x metric."""

    venue_id: str
    metric: str
    decision: Decision
    serve_model_id: str
    reasons: tuple[str, ...]
    weeks: tuple[WeekComparison, ...]
    alert: RollbackAlert | None

    def as_dict(self) -> dict[str, object]:
        """JSON-ready form."""
        return {
            "venue_id": self.venue_id,
            "metric": self.metric,
            "decision": self.decision,
            "serve_model_id": self.serve_model_id,
            "reasons": list(self.reasons),
            "weeks": [w.as_dict() for w in self.weeks],
            "alert": self.alert.as_dict() if self.alert else None,
        }


@dataclass(frozen=True)
class GateResult:
    """The Phase 2 gate for one venue x metric."""

    venue_id: str
    metric: str
    status: GateStatus
    challenger_wape: float | None
    baseline_wape: float | None
    weeks_better: int
    weeks_required: int
    weeks: tuple[WeekComparison, ...]
    reasons: tuple[str, ...]

    @property
    def passed(self) -> bool:
        """True only when the gate passed."""
        return self.status == "pass"

    def as_dict(self) -> dict[str, object]:
        """JSON-ready form."""
        return {
            "venue_id": self.venue_id,
            "metric": self.metric,
            "status": self.status,
            "passed": self.passed,
            "challenger_wape": self.challenger_wape,
            "baseline_wape": self.baseline_wape,
            "weeks_better": self.weeks_better,
            "weeks_required": self.weeks_required,
            "weeks": [w.as_dict() for w in self.weeks],
            "reasons": list(self.reasons),
        }


def latest_complete_week_start(evaluation_day: date) -> date:
    """Monday of the latest Monday-Sunday week ending on or before ``evaluation_day``."""
    monday = evaluation_day - timedelta(days=evaluation_day.weekday())
    return monday if evaluation_day.weekday() == 6 else monday - timedelta(days=7)


def _single_model(log: pl.DataFrame, label: str) -> str:
    ids = sorted(set(log["model_id"].to_list()))
    if len(ids) != 1:
        raise ValueError(
            f"the {label} log must hold exactly one model_id, found {len(ids)}: {', '.join(ids)}"
        )
    return str(ids[0])


@dataclass(frozen=True)
class _Matched:
    challenger_id: str
    baseline_id: str
    matched: pl.DataFrame
    baseline_scored: pl.DataFrame


def _match(
    challenger_log: pl.DataFrame, baseline_log: pl.DataFrame, actuals: DailyActuals
) -> _Matched:
    challenger_id = _single_model(challenger_log, "challenger")
    baseline_id = _single_model(baseline_log, "baseline")
    if challenger_id == baseline_id:
        raise ValueError(f"challenger and baseline logs are the same model ({challenger_id})")
    c = score(challenger_log, actuals)
    b = score(baseline_log, actuals)
    matched = b.select(
        [*MATCH_KEYS, "week_start", "actual", pl.col("abs_error").alias("b_abs")]
    ).join(
        c.select([*MATCH_KEYS, pl.col("abs_error").alias("c_abs")]),
        on=list(MATCH_KEYS),
        how="inner",
    )
    return _Matched(challenger_id, baseline_id, matched, b)


def _compare_week(
    m: _Matched, venue_id: str, metric: str, week_start: date, cfg: SelectionConfig
) -> WeekComparison:
    in_week = (
        (pl.col("venue_id") == venue_id)
        & (pl.col("metric") == metric)
        & (pl.col("week_start") == week_start)
    )
    rows = m.matched.filter(in_week)
    baseline_n = m.baseline_scored.filter(in_week).height
    pairs = rows.height
    actual_sum = float(rows["actual"].cast(pl.Float64).sum()) if pairs else 0.0
    if pairs < cfg.min_pairs_per_week:
        note = f"only {pairs} matched forecast(s); need {cfg.min_pairs_per_week}"
        return WeekComparison(week_start, pairs, baseline_n, None, None, "insufficient", note)
    if pairs < cfg.min_match_fraction * baseline_n:
        note = (
            f"challenger covered {pairs} of the baseline's {baseline_n} scored forecasts; "
            f"need {cfg.min_match_fraction:.0%}"
        )
        return WeekComparison(week_start, pairs, baseline_n, None, None, "insufficient", note)
    if actual_sum <= 0:
        note = "actuals sum to zero, so WAPE is undefined"
        return WeekComparison(week_start, pairs, baseline_n, None, None, "insufficient", note)
    c_wape = float(rows["c_abs"].cast(pl.Float64).sum()) / actual_sum
    b_wape = float(rows["b_abs"].cast(pl.Float64).sum()) / actual_sum
    worse = c_wape > b_wape * (1 + cfg.worse_margin)
    verdict: WeekVerdict = "worse" if worse else "not_worse"
    note = f"challenger WAPE {c_wape:.1%} vs baseline {b_wape:.1%}"
    return WeekComparison(week_start, pairs, baseline_n, c_wape, b_wape, verdict, note)


def _groups(m: _Matched, challenger_log: pl.DataFrame) -> list[tuple[str, str]]:
    keys = set(m.baseline_scored.select("venue_id", "metric").unique().iter_rows()) | set(
        challenger_log.select("venue_id", "metric").unique().iter_rows()
    )
    return sorted((str(v), str(k)) for v, k in keys)


def decide_rollback(
    challenger_log: pl.DataFrame,
    baseline_log: pl.DataFrame,
    actuals: DailyActuals,
    *,
    evaluation_day: date | None = None,
    config: SelectionConfig | None = None,
) -> list[RollbackDecision]:
    """The weekly rollback check, one decision per venue x metric (see module docs)."""
    cfg = config or SelectionConfig()
    m = _match(challenger_log, baseline_log, actuals)
    last_week = latest_complete_week_start(evaluation_day or actuals.last_day())
    week_starts = [last_week - timedelta(weeks=i) for i in range(cfg.rollback_weeks - 1, -1, -1)]
    decisions: list[RollbackDecision] = []
    for venue_id, metric in _groups(m, challenger_log):
        weeks = tuple(_compare_week(m, venue_id, metric, w, cfg) for w in week_starts)
        period = f"{format_day(weeks[0].week_start)} to {format_day(weeks[-1].week_end)}"
        good = [w for w in weeks if w.verdict == "not_worse"]
        if good:
            reasons = tuple(
                f"week of {format_day(w.week_start)}: not worse than the baseline ({w.note})"
                for w in good
            )
            decisions.append(
                RollbackDecision(venue_id, metric, "keep", m.challenger_id, reasons, weeks, None)
            )
        elif all(w.verdict == "worse" for w in weeks):
            alert = RollbackAlert(
                alert_id=hashlib.sha256(
                    f"{venue_id}|{metric}|{m.challenger_id}|{weeks[-1].week_start}".encode()
                ).hexdigest()[:16],
                venue_id=venue_id,
                metric=metric,
                challenger_model_id=m.challenger_id,
                baseline_model_id=m.baseline_id,
                weeks=weeks,
                message=(
                    f"The forecast model was less accurate than the simple baseline for "
                    f"{len(weeks)} weeks running ({period}). We're showing the baseline "
                    "forecast until the model is checked."
                ),
            )
            reasons = (
                f"challenger worse than the baseline in all {len(weeks)} complete weeks ({period})",
            )
            decisions.append(
                RollbackDecision(
                    venue_id, metric, "rollback_to_baseline", m.baseline_id, reasons, weeks, alert
                )
            )
        else:
            reasons = tuple(
                f"week of {format_day(w.week_start)}: {w.note}"
                for w in weeks
                if w.verdict == "insufficient"
            )
            decisions.append(
                RollbackDecision(
                    venue_id, metric, "insufficient_data", m.challenger_id, reasons, weeks, None
                )
            )
    return decisions


def beats_baseline(
    challenger_log: pl.DataFrame,
    baseline_log: pl.DataFrame,
    actuals: DailyActuals,
    *,
    holdout_weeks: int | Sequence[date] | None = None,
    training_end: date | None = None,
    evaluation_day: date | None = None,
    config: GateConfig | None = None,
) -> list[GateResult]:
    """The Phase 2 gate, one result per venue x metric (see module docs).

    ``holdout_weeks`` is a number of most recent complete weeks, or explicit
    Mondays. ``training_end`` (the challenger's last training day), if given,
    must be before every hold-out week, so the gate never scores a model on
    weeks it has seen.
    """
    cfg = config or GateConfig()
    eval_day = evaluation_day or actuals.last_day()
    last_week = latest_complete_week_start(eval_day)
    if holdout_weeks is None or isinstance(holdout_weeks, int):
        count = cfg.holdout_weeks if holdout_weeks is None else holdout_weeks
        if count < 1:
            raise ValueError("holdout_weeks must be at least 1")
        weeks_list = [last_week - timedelta(weeks=i) for i in range(count - 1, -1, -1)]
    else:
        weeks_list = sorted(set(holdout_weeks))
        if not weeks_list:
            raise ValueError("at least one hold-out week is needed")
        for w in weeks_list:
            if w.weekday() != 0:
                raise ValueError(f"hold-out weeks must start on a Monday, got {w.isoformat()}")
            if w > last_week:
                raise ValueError(
                    f"hold-out week {w.isoformat()} is not complete by {eval_day.isoformat()}"
                )
    if training_end is not None and weeks_list[0] <= training_end:
        raise ValueError(
            f"hold-out week {weeks_list[0].isoformat()} starts on or before the end of training "
            f"({training_end.isoformat()}); the gate must use weeks the model has not seen"
        )
    m = _match(challenger_log, baseline_log, actuals)
    required = cfg.weeks_required(len(weeks_list))
    results: list[GateResult] = []
    for venue_id, metric in _groups(m, challenger_log):
        weeks = tuple(_compare_week(m, venue_id, metric, w, cfg.selection) for w in weeks_list)
        better = sum(
            1
            for w in weeks
            if w.challenger_wape is not None
            and w.baseline_wape is not None
            and w.challenger_wape < w.baseline_wape
        )
        missing = [w for w in weeks if w.verdict == "insufficient"]
        if missing:
            reasons = tuple(f"week of {format_day(w.week_start)}: {w.note}" for w in missing)
            results.append(
                GateResult(
                    venue_id,
                    metric,
                    "insufficient_data",
                    None,
                    None,
                    better,
                    required,
                    weeks,
                    reasons,
                )
            )
            continue
        rows = m.matched.filter(
            (pl.col("venue_id") == venue_id)
            & (pl.col("metric") == metric)
            & pl.col("week_start").is_in(weeks_list)
        )
        actual_sum = float(rows["actual"].cast(pl.Float64).sum())
        c_wape = float(rows["c_abs"].cast(pl.Float64).sum()) / actual_sum
        b_wape = float(rows["b_abs"].cast(pl.Float64).sum()) / actual_sum
        overall_ok = c_wape < b_wape * (1 - cfg.min_relative_improvement)
        weeks_ok = better >= required
        reasons_list = [
            f"pooled WAPE {c_wape:.1%} vs baseline {b_wape:.1%}: "
            + ("lower" if overall_ok else "not low enough")
            + (
                f" (needs at least {cfg.min_relative_improvement:.0%} lower)"
                if cfg.min_relative_improvement
                else ""
            ),
            f"better in {better} of {len(weeks)} weeks (needs {required})",
        ]
        status: GateStatus = "pass" if overall_ok and weeks_ok else "fail"
        results.append(
            GateResult(
                venue_id,
                metric,
                status,
                c_wape,
                b_wape,
                better,
                required,
                weeks,
                tuple(reasons_list),
            )
        )
    return results
