"""Champion/challenger rollback and the Phase 2 gate on controlled SYNTHETIC weeks."""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import date, timedelta
from typing import Any, Literal, get_args

import polars as pl
import pytest

from foresite_forecast.accuracy import forecasts_to_frame
from foresite_forecast.schema import DailyActuals
from foresite_forecast.selection import (
    GateConfig,
    SelectionConfig,
    WeekComparison,
    beats_baseline,
    decide_rollback,
    format_day,
    latest_complete_week_start,
    rollback_verdict,
)
from tests.helpers import VENUE, build_actuals, make_forecast

FIRST_MONDAY = date(2026, 1, 5)
Mode = Literal["better", "worse", "tie", "missing", "thin", "partial", "zero"]
#: Challenger point per mode against an actual of 1000 and a baseline of 1100.
POINTS = {"better": 1050, "worse": 1200, "tie": 900, "thin": 1050, "partial": 1050, "zero": 1050}


@dataclass(frozen=True)
class Scenario:
    actuals: DailyActuals
    baseline: pl.DataFrame
    challenger: pl.DataFrame
    last_day: date


def scenario(modes: Sequence[str], *, challenger_points: dict[str, int] | None = None) -> Scenario:
    """One week per mode (see :data:`Mode`); the baseline is 10% high every day."""
    unknown = set(modes) - set(get_args(Mode))
    if unknown:
        raise ValueError(f"unknown modes: {unknown}")
    points = {**POINTS, **(challenger_points or {})}
    values: list[int | None | str] = []
    baseline = []
    challenger = []
    for w, mode in enumerate(modes):
        for d in range(7):
            target = FIRST_MONDAY + timedelta(days=7 * w + d)
            values.append(0 if mode == "zero" else 1000)
            baseline.append(make_forecast(target, 1100, model_id="baseline-swly-trend"))
            if mode == "missing" or (mode == "thin" and d >= 3) or (mode == "partial" and d >= 5):
                continue
            challenger.append(make_forecast(target, points[mode], model_id="challenger-x"))
    actuals = build_actuals(FIRST_MONDAY, values)
    return Scenario(
        actuals,
        forecasts_to_frame(baseline),
        forecasts_to_frame(challenger),
        FIRST_MONDAY + timedelta(days=7 * len(modes) - 1),
    )


def decide(modes: Sequence[str], config: SelectionConfig | None = None, **kw: Any) -> Any:
    s = scenario(modes, **kw)
    (decision,) = decide_rollback(s.challenger, s.baseline, s.actuals, config=config)
    return decision


def test_rolls_back_after_four_complete_worse_weeks() -> None:
    d = decide(["better", "worse", "worse", "worse", "worse"])
    assert d.decision == "rollback_to_baseline"
    assert d.serve_model_id == "baseline-swly-trend"
    assert [w.verdict for w in d.weeks] == ["worse"] * 4
    assert d.weeks[0].week_start == date(2026, 1, 12)
    assert d.weeks[0].challenger_wape == pytest.approx(0.2)
    assert d.weeks[0].baseline_wape == pytest.approx(0.1)
    assert d.alert is not None
    assert d.alert.challenger_model_id == "challenger-x"
    assert d.alert.message == (
        "The forecast model was less accurate than the simple baseline for 4 weeks running "
        "(12 Jan 2026 to 8 Feb 2026). We're showing the baseline forecast until the model "
        "is checked."
    )
    again = decide(["better", "worse", "worse", "worse", "worse"])
    assert again.alert is not None
    assert again.alert.alert_id == d.alert.alert_id  # same run of weeks, same id: no duplicates
    payload = json.loads(json.dumps(d.as_dict()))
    assert payload["alert"]["kind"] == "forecast_rollback"
    assert payload["weeks"][0]["week_end"] == "2026-01-18"


def test_three_worse_weeks_do_not_roll_back() -> None:
    d = decide(["better", "better", "worse", "worse", "worse"])
    assert d.decision == "keep"
    assert d.serve_model_id == "challenger-x"
    assert d.alert is None
    assert d.reasons[0].startswith("week of 12 Jan 2026: not worse")


def test_a_tie_is_not_worse() -> None:
    d = decide(["worse", "worse", "worse", "tie"])
    assert d.decision == "keep"
    assert d.weeks[-1].challenger_wape == d.weeks[-1].baseline_wape


@pytest.mark.parametrize(
    ("modes", "note"),
    [
        (["missing", "worse", "worse", "worse"], "only 0 matched forecast(s); need 7"),
        (["thin", "worse", "worse", "worse"], "only 3 matched forecast(s); need 7"),
        (["zero", "worse", "worse", "worse"], "actuals sum to zero"),
        (["worse", "worse", "worse"], "only 0 matched"),
    ],
)
def test_missing_or_thin_weeks_never_trigger_rollback(modes: list[Mode], note: str) -> None:
    d = decide(modes)
    assert d.decision == "insufficient_data"
    assert d.serve_model_id == "challenger-x"
    assert d.alert is None
    assert any(note in r for r in d.reasons), d.reasons


def test_challenger_must_cover_most_of_the_baselines_forecasts() -> None:
    d = decide(["partial", "worse", "worse", "worse"], SelectionConfig(min_pairs_per_week=1))
    assert d.decision == "insufficient_data"
    assert "covered 5 of the baseline's 7" in d.weeks[0].note


def test_worse_margin() -> None:
    modes: list[Mode] = ["worse"] * 4
    slightly = {"worse": 1110}  # 11% vs 10% WAPE
    assert decide(modes, challenger_points=slightly).decision == "rollback_to_baseline"
    lenient = SelectionConfig(worse_margin=0.2)
    assert decide(modes, lenient, challenger_points=slightly).decision == "keep"


def test_incomplete_week_is_not_evaluated() -> None:
    s = scenario(["worse"] * 5)
    mid_week = s.last_day - timedelta(days=2)  # the fifth week has not finished
    (d,) = decide_rollback(s.challenger, s.baseline, s.actuals, evaluation_day=mid_week)
    assert d.weeks[-1].week_start == date(2026, 1, 26)
    assert d.decision == "rollback_to_baseline"


def test_latest_complete_week_start() -> None:
    assert latest_complete_week_start(date(2026, 10, 18)) == date(2026, 10, 12)  # Sunday
    assert latest_complete_week_start(date(2026, 10, 17)) == date(2026, 10, 5)  # Saturday
    assert latest_complete_week_start(date(2026, 10, 12)) == date(2026, 10, 5)  # Monday
    assert format_day(date(2026, 10, 8)) == "8 Oct 2026"


def test_logs_must_each_hold_one_model() -> None:
    s = scenario(["better"] * 4)
    mixed = pl.concat([s.challenger, s.baseline])
    with pytest.raises(ValueError, match="exactly one model_id, found 2"):
        decide_rollback(mixed, s.baseline, s.actuals)
    with pytest.raises(ValueError, match="challenger log is empty"):
        decide_rollback(s.challenger.clear(), s.baseline, s.actuals)
    with pytest.raises(ValueError, match="same model"):
        decide_rollback(s.baseline, s.baseline, s.actuals)


def week(verdict: Literal["worse", "not_worse", "insufficient"]) -> WeekComparison:
    return WeekComparison(FIRST_MONDAY, 7, 7, None, None, verdict, "")


def test_rollback_verdict_rule() -> None:
    assert rollback_verdict([week("worse")] * 4) == "rollback_to_baseline"
    assert rollback_verdict([week("worse")] * 3) == "insufficient_data"
    assert rollback_verdict([week("worse")] * 3 + [week("not_worse")]) == "keep"
    assert rollback_verdict([week("insufficient")] + [week("worse")] * 3) == "insufficient_data"
    assert rollback_verdict([week("insufficient")] * 3 + [week("not_worse")]) == "keep"
    assert rollback_verdict([]) == "insufficient_data"
    assert rollback_verdict([week("worse")] * 2, required_weeks=2) == "rollback_to_baseline"


@pytest.mark.parametrize(
    "changes",
    [
        {"rollback_weeks": 0},
        {"worse_margin": -0.1},
        {"min_pairs_per_week": 0},
        {"min_match_fraction": 0.0},
        {"min_match_fraction": 1.5},
    ],
)
def test_selection_config_is_validated(changes: dict[str, Any]) -> None:
    with pytest.raises(ValueError):  # noqa: PT011  # each case has its own message
        replace(SelectionConfig(), **changes)


# -- Phase 2 gate --------------------------------------------------------------------


def gate(modes: Sequence[str], config: GateConfig | None = None, **kw: Any) -> Any:
    s = scenario(modes)
    (result,) = beats_baseline(s.challenger, s.baseline, s.actuals, config=config, **kw)
    return result


def test_gate_passes_a_clearly_better_model() -> None:
    g = gate(["better"] * 8)
    assert g.passed
    assert g.status == "pass"
    assert g.challenger_wape == pytest.approx(0.05)
    assert g.baseline_wape == pytest.approx(0.10)
    assert (g.weeks_better, g.weeks_required) == (8, 6)
    assert json.loads(json.dumps(g.as_dict()))["passed"] is True


def test_gate_needs_enough_winning_weeks() -> None:
    # 5 of 8 weeks better and pooled WAPE lower: still fails, needs 6.
    g = gate(["better"] * 5 + ["tie"] * 3)
    assert g.status == "fail"
    assert g.weeks_better == 5
    assert "better in 5 of 8 weeks (needs 6)" in g.reasons


def test_gate_needs_lower_pooled_wape() -> None:
    g = gate(["better"] * 6 + ["worse"] * 2, GateConfig(min_relative_improvement=0.5))
    assert g.status == "fail"
    assert g.challenger_wape == pytest.approx((6 * 0.05 + 2 * 0.2) / 8)
    assert "not low enough (needs at least 50% lower)" in g.reasons[0]


def test_gate_with_missing_week_is_insufficient() -> None:
    g = gate(["better"] * 7 + ["missing"])
    assert g.status == "insufficient_data"
    assert not g.passed


def test_gate_explicit_weeks_and_training_end() -> None:
    s = scenario(["worse"] * 4 + ["better"] * 4)
    weeks = [FIRST_MONDAY + timedelta(weeks=i) for i in range(4, 8)]
    (g,) = beats_baseline(
        s.challenger,
        s.baseline,
        s.actuals,
        holdout_weeks=weeks,
        training_end=weeks[0] - timedelta(days=1),
    )
    assert g.passed
    assert (g.weeks_better, g.weeks_required) == (4, 3)
    with pytest.raises(ValueError, match="model has not seen"):
        beats_baseline(
            s.challenger, s.baseline, s.actuals, holdout_weeks=weeks, training_end=weeks[0]
        )
    with pytest.raises(ValueError, match="start on a Monday"):
        beats_baseline(
            s.challenger, s.baseline, s.actuals, holdout_weeks=[weeks[0] + timedelta(days=1)]
        )
    with pytest.raises(ValueError, match="not complete"):
        beats_baseline(
            s.challenger, s.baseline, s.actuals, holdout_weeks=[weeks[-1] + timedelta(weeks=1)]
        )
    with pytest.raises(ValueError, match="at least one hold-out week"):
        beats_baseline(s.challenger, s.baseline, s.actuals, holdout_weeks=[])
    with pytest.raises(ValueError, match="at least 1"):
        beats_baseline(s.challenger, s.baseline, s.actuals, holdout_weeks=0)
    (last4,) = beats_baseline(s.challenger, s.baseline, s.actuals, holdout_weeks=4)
    assert last4.passed


def test_weeks_required() -> None:
    assert GateConfig().weeks_required(8) == 6
    assert GateConfig().weeks_required(4) == 3
    assert GateConfig().weeks_required(1) == 1
    assert GateConfig(min_weeks_better_fraction=1.0).weeks_required(8) == 8
    assert GateConfig(min_weeks_better=10).weeks_required(8) == 8
    assert GateConfig(min_weeks_better=2).weeks_required(8) == 2


@pytest.mark.parametrize(
    "changes",
    [
        {"holdout_weeks": 0},
        {"min_weeks_better_fraction": 0.0},
        {"min_weeks_better": 0},
        {"min_relative_improvement": 1.0},
        {"min_relative_improvement": -0.1},
    ],
)
def test_gate_config_is_validated(changes: dict[str, Any]) -> None:
    with pytest.raises(ValueError):  # noqa: PT011  # each case has its own message
        replace(GateConfig(), **changes)


def test_each_venue_gets_its_own_decision() -> None:
    s = scenario(["worse"] * 4)
    other = s.baseline.with_columns(venue_id=pl.lit("SYNTH-V2"))
    decisions = decide_rollback(s.challenger, pl.concat([s.baseline, other]), s.actuals)
    assert [(d.venue_id, d.decision) for d in decisions] == [
        (VENUE, "rollback_to_baseline"),
        ("SYNTH-V2", "insufficient_data"),  # no actuals or challenger forecasts there
    ]
