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
a good week.

*Rollback is one-way* (enforced through :class:`RollbackRecord` state, which
the CLI persists with ``evaluate --state <file>``): once
``rollback_to_baseline`` has been decided for a challenger id + version at a
venue x metric, every later check keeps deciding ``rollback_to_baseline`` and
serving the baseline, whatever the weekly comparison says, until a person
re-runs the Phase 2 gate and it passes (:func:`reinstate`;
``evaluate --state <file> --reinstate --training-end <day>``). A new
challenger version is a new challenger: it needs its own gate pass before it
goes live. The weekly verdict is still recorded on the record as a
re-confirmation (:class:`RollbackCheck`).

*Alert de-duplication*: the ``alert_id`` is a hash of venue, metric,
challenger id, challenger version and the **trigger week**: the last week of
the first all-worse run of ``rollback_weeks`` weeks in the current unbroken
streak of worse weeks. So it is the same on every re-run and in every later
week while the challenger stays worse, even without a state file; with one,
the id is taken from the record. Consumers de-duplicate on ``alert_id``;
``new`` is true only on the check that created the rollback record.

*Phase 2 gate* (:func:`beats_baseline`): on the hold-out weeks (default the
last 8 complete weeks), every week must be evaluable, the challenger's pooled
WAPE must be lower than the baseline's by at least
``min_relative_improvement`` (default 0: strictly lower), and the challenger
must be strictly better in at least N of the M weeks, N =
``ceil(min_weeks_better_fraction x M)`` (default 0.75, so 6 of 8).
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from pathlib import Path
from typing import Literal, cast

import polars as pl

from foresite_forecast.accuracy import score
from foresite_forecast.csvio import ID_PATTERN, atomic_text_writer, parse_iso_date
from foresite_forecast.schema import DailyActuals

MATCH_KEYS: tuple[str, ...] = ("venue_id", "section_id", "metric", "target_day", "horizon_days")

WeekVerdict = Literal["worse", "not_worse", "insufficient"]
Decision = Literal["keep", "rollback_to_baseline", "insufficient_data"]
GateStatus = Literal["pass", "fail", "insufficient_data"]
RecordStatus = Literal["active", "reinstated"]


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
    ``alert_id`` is stable per challenger id + version + rollback event (its
    trigger week), so re-running the check, or checking again in later weeks
    while the rollback stands, never raises a different alert. ``new`` is true
    only on the check that started the rollback; ``weeks`` are the weeks of the
    check that produced this copy.
    """

    alert_id: str
    venue_id: str
    metric: str
    challenger_model_id: str
    challenger_model_version: str
    baseline_model_id: str
    trigger_week_start: date
    weeks: tuple[WeekComparison, ...]
    message: str
    new: bool = True
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
            "challenger_model_version": self.challenger_model_version,
            "baseline_model_id": self.baseline_model_id,
            "trigger_week_start": self.trigger_week_start.isoformat(),
            "new": self.new,
            "weeks": [w.as_dict() for w in self.weeks],
            "message": self.message,
        }


@dataclass(frozen=True)
class RollbackCheck:
    """One weekly re-confirmation of a standing rollback: what the weekly rule said."""

    week_start: date
    verdict: Decision

    def as_dict(self) -> dict[str, object]:
        """JSON-ready form."""
        return {"week_start": self.week_start.isoformat(), "verdict": self.verdict}


@dataclass(frozen=True)
class RollbackRecord:
    """Persisted rollback state for one challenger id + version at one venue x metric.

    ``status`` is ``active`` (serve the baseline) until :func:`reinstate`
    marks it ``reinstated`` after a passing Phase 2 gate. ``checks`` holds one
    :class:`RollbackCheck` per evaluated week (latest complete week of each
    check), so the record shows whether the challenger is still worse.
    """

    venue_id: str
    metric: str
    challenger_model_id: str
    challenger_model_version: str
    baseline_model_id: str
    alert_id: str
    trigger_week_start: date
    status: RecordStatus = "active"
    checks: tuple[RollbackCheck, ...] = ()
    reinstated_on: date | None = None

    @property
    def key(self) -> tuple[str, str, str, str]:
        """Venue, metric, challenger id and version."""
        return (
            self.venue_id,
            self.metric,
            self.challenger_model_id,
            self.challenger_model_version,
        )

    def with_check(self, check: RollbackCheck) -> RollbackRecord:
        """This record with ``check`` added (replacing an earlier check of the same week)."""
        kept = [c for c in self.checks if c.week_start != check.week_start]
        return replace(self, checks=tuple(sorted([*kept, check], key=lambda c: c.week_start)))

    def as_dict(self) -> dict[str, object]:
        """JSON-ready form (the state file format)."""
        return {
            "venue_id": self.venue_id,
            "metric": self.metric,
            "challenger_model_id": self.challenger_model_id,
            "challenger_model_version": self.challenger_model_version,
            "baseline_model_id": self.baseline_model_id,
            "alert_id": self.alert_id,
            "trigger_week_start": self.trigger_week_start.isoformat(),
            "status": self.status,
            "checks": [c.as_dict() for c in self.checks],
            "reinstated_on": None if self.reinstated_on is None else self.reinstated_on.isoformat(),
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
    #: What the weekly rule alone said (differs from ``decision`` while a
    #: persisted rollback stands).
    weekly_verdict: Decision | None = None
    #: The rollback record after this check (``None`` when no rollback stands).
    record: RollbackRecord | None = None

    def as_dict(self) -> dict[str, object]:
        """JSON-ready form."""
        return {
            "venue_id": self.venue_id,
            "metric": self.metric,
            "decision": self.decision,
            "weekly_verdict": self.weekly_verdict,
            "serve_model_id": self.serve_model_id,
            "reasons": list(self.reasons),
            "weeks": [w.as_dict() for w in self.weeks],
            "alert": self.alert.as_dict() if self.alert else None,
            "rollback_record": self.record.as_dict() if self.record else None,
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
    if log.height == 0:
        raise ValueError(
            f"the {label} log is empty: there are no forecasts to evaluate. A live model that "
            "issued nothing is an outage; check the forecast job"
        )
    ids = sorted(set(log["model_id"].to_list()))
    if len(ids) != 1:
        raise ValueError(
            f"the {label} log must hold exactly one model_id, found {len(ids)}: {', '.join(ids)}"
        )
    return str(ids[0])


def _latest_version(log: pl.DataFrame) -> str:
    """The ``model_version`` of the most recently issued forecast (later row wins a tie)."""
    return str(log.sort("issued_at", maintain_order=True)["model_version"][-1])


def model_identity(log: pl.DataFrame, label: str = "challenger") -> tuple[str, str]:
    """``(model_id, model_version)`` of a one-model log; the version of its latest issue."""
    return _single_model(log, label), _latest_version(log)


@dataclass(frozen=True)
class _Matched:
    challenger_id: str
    challenger_version: str
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
    return _Matched(challenger_id, _latest_version(challenger_log), baseline_id, matched, b)


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


def _groups(baseline_log: pl.DataFrame, challenger_log: pl.DataFrame) -> list[tuple[str, str]]:
    """Every venue x metric in either log, so none is silently skipped."""
    keys = set(baseline_log.select("venue_id", "metric").unique().iter_rows()) | set(
        challenger_log.select("venue_id", "metric").unique().iter_rows()
    )
    return sorted((str(v), str(k)) for v, k in keys)


def rollback_verdict(weeks: Sequence[WeekComparison], required_weeks: int = 4) -> Decision:
    """The rollback rule on its own, for the last ``required_weeks`` complete weeks.

    ``keep`` if any week is evaluable and not worse; ``rollback_to_baseline``
    only if there are exactly ``required_weeks`` weeks and every one is worse;
    otherwise ``insufficient_data``.
    """
    if any(w.verdict == "not_worse" for w in weeks):
        return "keep"
    if len(weeks) == required_weeks and all(w.verdict == "worse" for w in weeks):
        return "rollback_to_baseline"
    return "insufficient_data"


def _trigger_week(
    m: _Matched, venue_id: str, metric: str, last_week: date, cfg: SelectionConfig
) -> date:
    """Last week of the first all-worse run in the unbroken streak of worse weeks ending now."""
    earliest = last_week
    while _compare_week(m, venue_id, metric, earliest - timedelta(weeks=1), cfg).verdict == "worse":
        earliest -= timedelta(weeks=1)
    return earliest + timedelta(weeks=cfg.rollback_weeks - 1)


def _alert_id(venue_id: str, metric: str, challenger: str, version: str, trigger: date) -> str:
    raw = f"{venue_id}|{metric}|{challenger}|{version}|{trigger.isoformat()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _active_records(
    state: Iterable[RollbackRecord],
) -> dict[tuple[str, str, str, str], RollbackRecord]:
    active: dict[tuple[str, str, str, str], RollbackRecord] = {}
    for record in state:
        if record.status == "active":
            active[record.key] = record
    return active


REINSTATE_HOW = (
    "it stays on the baseline until a person re-runs the Phase 2 gate and it passes "
    "(evaluate --state <file> --reinstate --training-end <day>)"
)


def decide_rollback(
    challenger_log: pl.DataFrame,
    baseline_log: pl.DataFrame,
    actuals: DailyActuals,
    *,
    evaluation_day: date | None = None,
    config: SelectionConfig | None = None,
    state: Sequence[RollbackRecord] = (),
) -> list[RollbackDecision]:
    """The weekly rollback check, one decision per venue x metric (see module docs).

    ``state`` is the persisted rollback records from earlier checks. An
    ``active`` record for this challenger id + version keeps the decision at
    ``rollback_to_baseline`` (serving the baseline) whatever the weekly rule
    says; the weekly verdict is recorded on the record as a re-confirmation.
    Merge the decisions back into the state with :func:`updated_state`.
    """
    cfg = config or SelectionConfig()
    m = _match(challenger_log, baseline_log, actuals)
    last_week = latest_complete_week_start(evaluation_day or actuals.last_day())
    week_starts = [last_week - timedelta(weeks=i) for i in range(cfg.rollback_weeks - 1, -1, -1)]
    active = _active_records(state)
    decisions: list[RollbackDecision] = []
    for venue_id, metric in _groups(baseline_log, challenger_log):
        weeks = tuple(_compare_week(m, venue_id, metric, w, cfg) for w in week_starts)
        period = f"{format_day(weeks[0].week_start)} to {format_day(weeks[-1].week_end)}"
        verdict = rollback_verdict(weeks, cfg.rollback_weeks)
        check = RollbackCheck(last_week, verdict)
        standing = active.get((venue_id, metric, m.challenger_id, m.challenger_version))
        if standing is not None:
            record = standing.with_check(check)
            alert = RollbackAlert(
                alert_id=standing.alert_id,
                venue_id=venue_id,
                metric=metric,
                challenger_model_id=m.challenger_id,
                challenger_model_version=m.challenger_version,
                baseline_model_id=standing.baseline_model_id,
                trigger_week_start=standing.trigger_week_start,
                weeks=weeks,
                message=(
                    "We're still showing the simple baseline forecast: the forecast model was "
                    "less accurate than it for 4 weeks running up to the week of "
                    f"{format_day(standing.trigger_week_start)}. It stays that way until the "
                    "model is checked and passes the Phase 2 test again."
                ),
                new=False,
            )
            reasons: tuple[str, ...] = (
                f"rolled back since the week of {format_day(standing.trigger_week_start)} "
                f"(alert {standing.alert_id}); {REINSTATE_HOW}",
                f"this week's check on its own: {verdict}",
            )
            decisions.append(
                RollbackDecision(
                    venue_id,
                    metric,
                    "rollback_to_baseline",
                    standing.baseline_model_id,
                    reasons,
                    weeks,
                    alert,
                    verdict,
                    record,
                )
            )
            continue
        good = [w for w in weeks if w.verdict == "not_worse"]
        if verdict == "keep":
            reasons = tuple(
                f"week of {format_day(w.week_start)}: not worse than the baseline ({w.note})"
                for w in good
            )
            decisions.append(
                RollbackDecision(
                    venue_id, metric, "keep", m.challenger_id, reasons, weeks, None, verdict
                )
            )
        elif verdict == "rollback_to_baseline":
            trigger = _trigger_week(m, venue_id, metric, last_week, cfg)
            alert_id = _alert_id(venue_id, metric, m.challenger_id, m.challenger_version, trigger)
            alert = RollbackAlert(
                alert_id=alert_id,
                venue_id=venue_id,
                metric=metric,
                challenger_model_id=m.challenger_id,
                challenger_model_version=m.challenger_version,
                baseline_model_id=m.baseline_id,
                trigger_week_start=trigger,
                weeks=weeks,
                message=(
                    f"The forecast model was less accurate than the simple baseline for "
                    f"{len(weeks)} weeks running ({period}). We're showing the baseline "
                    "forecast until the model is checked."
                ),
            )
            record = RollbackRecord(
                venue_id=venue_id,
                metric=metric,
                challenger_model_id=m.challenger_id,
                challenger_model_version=m.challenger_version,
                baseline_model_id=m.baseline_id,
                alert_id=alert_id,
                trigger_week_start=trigger,
                checks=(check,),
            )
            reasons = (
                f"challenger worse than the baseline in all {len(weeks)} complete weeks ({period})",
                REINSTATE_HOW,
            )
            decisions.append(
                RollbackDecision(
                    venue_id,
                    metric,
                    "rollback_to_baseline",
                    m.baseline_id,
                    reasons,
                    weeks,
                    alert,
                    verdict,
                    record,
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
                    venue_id,
                    metric,
                    "insufficient_data",
                    m.challenger_id,
                    reasons,
                    weeks,
                    None,
                    verdict,
                )
            )
    return decisions


def updated_state(
    state: Sequence[RollbackRecord], decisions: Iterable[RollbackDecision]
) -> list[RollbackRecord]:
    """``state`` with each decision's record merged in (matched on ``alert_id``)."""
    out = list(state)
    for d in decisions:
        if d.record is None:
            continue
        index = next((i for i, r in enumerate(out) if r.alert_id == d.record.alert_id), None)
        if index is None:
            out.append(d.record)
        else:
            out[index] = d.record
    return out


def reinstate(
    state: Sequence[RollbackRecord],
    gates: Iterable[GateResult],
    *,
    challenger_model_id: str,
    challenger_model_version: str,
    on: date,
) -> tuple[list[RollbackRecord], list[str]]:
    """Mark active rollbacks of this challenger ``reinstated`` where its Phase 2 gate passed.

    Only a passing gate reinstates; anything else leaves the rollback active.
    Returns the new state and one plain-English line per active record touched.
    """
    by_group = {(g.venue_id, g.metric): g for g in gates}
    out: list[RollbackRecord] = []
    notes: list[str] = []
    for record in state:
        if (
            record.status != "active"
            or record.challenger_model_id != challenger_model_id
            or record.challenger_model_version != challenger_model_version
        ):
            out.append(record)
            continue
        g = by_group.get((record.venue_id, record.metric))
        where = f"{record.venue_id} {record.metric}"
        if g is not None and g.passed:
            out.append(replace(record, status="reinstated", reinstated_on=on))
            notes.append(
                f"Reinstated {challenger_model_id} {challenger_model_version} for {where}: "
                "Phase 2 gate passed."
            )
        else:
            out.append(record)
            status = "not run" if g is None else g.status
            notes.append(
                f"Not reinstated for {where}: Phase 2 gate {status}; still serving the baseline."
            )
    return out, notes


STATE_SCHEMA = "foresite-rollback-state"
STATE_VERSION = 1


def _state_error(path: Path, problem: str) -> ValueError:
    return ValueError(f"rollback state file {path}: {problem}")


def _record_from_dict(raw: object, path: Path, index: int) -> RollbackRecord:
    where = f"rollbacks[{index}]"
    if not isinstance(raw, Mapping):
        raise _state_error(path, f"{where} must be an object")
    row = cast(Mapping[str, object], raw)

    def text(name: str) -> str:
        value = row.get(name)
        if not isinstance(value, str) or not value:
            raise _state_error(path, f"{where}.{name} must be a non-empty string")
        return value

    def day(name: str, value: object) -> date:
        parsed = parse_iso_date(value) if isinstance(value, str) else None
        if parsed is None:
            raise _state_error(path, f"{where}.{name} must be a date written YYYY-MM-DD")
        return parsed

    for name in ("venue_id", "metric", "challenger_model_id", "baseline_model_id"):
        if not ID_PATTERN.match(text(name)):
            raise _state_error(path, f"{where}.{name} is not a valid identifier")
    status = text("status")
    if status not in ("active", "reinstated"):
        raise _state_error(path, f"{where}.status must be 'active' or 'reinstated'")
    raw_checks = row.get("checks", [])
    if not isinstance(raw_checks, list):
        raise _state_error(path, f"{where}.checks must be a list")
    checks: list[RollbackCheck] = []
    for c in cast(list[object], raw_checks):
        if not isinstance(c, Mapping):
            raise _state_error(path, f"{where}.checks entries must be objects")
        entry = cast(Mapping[str, object], c)
        verdict = entry.get("verdict")
        if verdict not in ("keep", "rollback_to_baseline", "insufficient_data"):
            raise _state_error(path, f"{where}.checks verdict is not a known decision")
        checks.append(
            RollbackCheck(
                day("checks.week_start", entry.get("week_start")), cast(Decision, verdict)
            )
        )
    reinstated = row.get("reinstated_on")
    return RollbackRecord(
        venue_id=text("venue_id"),
        metric=text("metric"),
        challenger_model_id=text("challenger_model_id"),
        challenger_model_version=text("challenger_model_version"),
        baseline_model_id=text("baseline_model_id"),
        alert_id=text("alert_id"),
        trigger_week_start=day("trigger_week_start", row.get("trigger_week_start")),
        status=cast(RecordStatus, status),
        checks=tuple(checks),
        reinstated_on=None if reinstated is None else day("reinstated_on", reinstated),
    )


def read_rollback_state(path: Path) -> list[RollbackRecord]:
    """Read a rollback state file; a missing file is an empty state."""
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _state_error(path, f"not valid JSON ({exc})") from None
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != STATE_SCHEMA
        or payload.get("version") != STATE_VERSION
    ):
        raise _state_error(path, f"expected a {STATE_SCHEMA} version {STATE_VERSION} object")
    rollbacks = payload.get("rollbacks")
    if not isinstance(rollbacks, list):
        raise _state_error(path, "rollbacks must be a list")
    return [_record_from_dict(r, path, i) for i, r in enumerate(cast(list[object], rollbacks))]


def write_rollback_state(path: Path, state: Iterable[RollbackRecord]) -> None:
    """Write the rollback state file atomically (temporary file, fsync, rename)."""
    payload = {
        "schema": STATE_SCHEMA,
        "version": STATE_VERSION,
        "rollbacks": [r.as_dict() for r in state],
    }
    with atomic_text_writer(path) as handle:
        handle.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")


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
    for venue_id, metric in _groups(baseline_log, challenger_log):
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
