"""Champion/challenger rollback and the Phase 2 gate on controlled SYNTHETIC weeks."""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Literal, get_args

import polars as pl
import pytest

from foresite_forecast.accuracy import forecasts_to_frame
from foresite_forecast.schema import DailyActuals
from foresite_forecast.selection import (
    GateConfig,
    RollbackCheck,
    RollbackRecord,
    SelectionConfig,
    WeekComparison,
    beats_baseline,
    decide_rollback,
    format_day,
    latest_complete_week_start,
    model_identity,
    read_rollback_state,
    reinstate,
    rollback_verdict,
    updated_state,
    write_rollback_state,
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


# -- one-way rollback (persisted state) and alert de-duplication ----------------------


def week_end(i: int) -> date:
    """The Sunday ending week ``i`` (0-based) of a scenario."""
    return FIRST_MONDAY + timedelta(days=7 * i + 6)


def test_keep_after_a_prior_rollback_does_not_switch_back() -> None:
    s = scenario(["worse"] * 4 + ["better"] * 4)
    (first,) = decide_rollback(s.challenger, s.baseline, s.actuals, evaluation_day=week_end(3))
    assert first.decision == "rollback_to_baseline"
    assert first.record is not None
    assert first.alert is not None
    assert first.alert.new
    state = updated_state([], [first])
    assert state == [first.record]
    # Four good weeks later the weekly rule alone says keep, but the rollback stands.
    (later,) = decide_rollback(
        s.challenger, s.baseline, s.actuals, evaluation_day=week_end(7), state=state
    )
    stateless = decide_rollback(s.challenger, s.baseline, s.actuals, evaluation_day=week_end(7))
    assert stateless[0].decision == "keep"
    assert later.weekly_verdict == "keep"
    assert later.decision == "rollback_to_baseline"
    assert later.serve_model_id == "baseline-swly-trend"
    assert later.alert is not None
    assert later.alert.alert_id == first.alert.alert_id
    assert not later.alert.new
    assert "Phase 2 gate" in later.reasons[0]
    assert "--reinstate" in later.reasons[0]
    assert later.record is not None
    assert [c.verdict for c in later.record.checks] == ["rollback_to_baseline", "keep"]
    state = updated_state(state, [later])
    assert len(state) == 1
    # Re-running the same week replaces that week's check rather than adding another.
    (again,) = decide_rollback(
        s.challenger, s.baseline, s.actuals, evaluation_day=week_end(7), state=state
    )
    assert again.record is not None
    assert len(again.record.checks) == 2
    payload = json.loads(json.dumps(later.as_dict()))
    assert payload["rollback_record"]["status"] == "active"
    assert payload["weekly_verdict"] == "keep"


def test_alert_id_is_stable_across_reruns_and_later_weeks() -> None:
    s = scenario(["better"] + ["worse"] * 7)
    ids = []
    for i in range(4, 8):  # first triggered at the end of week 4, still worse to week 7
        (d,) = decide_rollback(s.challenger, s.baseline, s.actuals, evaluation_day=week_end(i))
        assert d.decision == "rollback_to_baseline"
        assert d.alert is not None
        assert d.alert.trigger_week_start == FIRST_MONDAY + timedelta(weeks=4)
        ids.append(d.alert.alert_id)
    assert len(set(ids)) == 1  # stateless: still one alert for one rollback event
    # With state, later weeks keep the recorded id and are not new alerts.
    (d,) = decide_rollback(s.challenger, s.baseline, s.actuals, evaluation_day=week_end(4))
    state = updated_state([], [d])
    for i in range(5, 8):
        (d,) = decide_rollback(
            s.challenger, s.baseline, s.actuals, evaluation_day=week_end(i), state=state
        )
        assert d.alert is not None
        assert (d.alert.alert_id, d.alert.new) == (ids[0], False)
        state = updated_state(state, [d])
    assert len(state) == 1
    assert [c.week_start for c in state[0].checks] == [
        FIRST_MONDAY + timedelta(weeks=i) for i in range(4, 8)
    ]


def test_a_new_rollback_event_or_version_gets_a_new_alert_id() -> None:
    first = scenario(["worse"] * 4)
    (a,) = decide_rollback(first.challenger, first.baseline, first.actuals)
    broken = scenario(["worse"] * 4 + ["better"] + ["worse"] * 4)
    (b,) = decide_rollback(broken.challenger, broken.baseline, broken.actuals)
    assert a.alert is not None
    assert b.alert is not None
    assert b.alert.trigger_week_start == FIRST_MONDAY + timedelta(weeks=8)
    assert a.alert.alert_id != b.alert.alert_id
    v2 = first.challenger.with_columns(model_version=pl.lit("2"))
    (c,) = decide_rollback(v2, first.baseline, first.actuals, state=updated_state([], [a]))
    assert c.alert is not None
    assert c.alert.new  # a new version is a new challenger: the old record does not apply
    assert c.alert.alert_id != a.alert.alert_id
    assert model_identity(v2) == ("challenger-x", "2")


def test_reinstate_needs_a_passing_gate() -> None:
    s = scenario(["worse"] * 4 + ["better"] * 8)
    (rolled,) = decide_rollback(s.challenger, s.baseline, s.actuals, evaluation_day=week_end(3))
    state = updated_state([], [rolled])
    other = RollbackRecord("SYNTH-V2", "covers", "other-model", "9", "b", "abc", FIRST_MONDAY)
    state = [*state, other]
    (failing,) = beats_baseline(s.challenger, s.baseline, s.actuals, evaluation_day=week_end(7))
    assert not failing.passed
    kept, notes = reinstate(
        state,
        [failing],
        challenger_model_id="challenger-x",
        challenger_model_version="1",
        on=week_end(7),
    )
    assert kept == state
    assert notes == [
        f"Not reinstated for {VENUE} net_sales_ex_gst_cents: Phase 2 gate fail; "
        "still serving the baseline."
    ]
    _, notes = reinstate(
        state, [], challenger_model_id="challenger-x", challenger_model_version="1", on=FIRST_MONDAY
    )
    assert "Phase 2 gate not run" in notes[0]
    (passing,) = beats_baseline(s.challenger, s.baseline, s.actuals)
    assert passing.passed
    new_state, notes = reinstate(
        state,
        [passing],
        challenger_model_id="challenger-x",
        challenger_model_version="1",
        on=week_end(11),
    )
    assert notes[0].startswith("Reinstated challenger-x 1 for SYNTH-V")
    assert new_state[0].status == "reinstated"
    assert new_state[0].reinstated_on == week_end(11)
    assert new_state[1] == other  # other challengers untouched
    (d,) = decide_rollback(s.challenger, s.baseline, s.actuals, state=new_state)
    assert d.decision == "keep"
    assert d.serve_model_id == "challenger-x"
    assert updated_state(new_state, [d]) == new_state


def test_state_file_round_trip_and_validation(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    assert read_rollback_state(path) == []  # no file yet: empty state
    record = RollbackRecord(
        VENUE,
        "net_sales_ex_gst_cents",
        "challenger-x",
        "1.0.0+cfg.ab",
        "baseline-swly-trend",
        "0123456789abcdef",
        FIRST_MONDAY,
        "reinstated",
        (RollbackCheck(FIRST_MONDAY, "rollback_to_baseline"),),
        FIRST_MONDAY + timedelta(days=30),
    )
    write_rollback_state(path, [record])
    assert read_rollback_state(path) == [record]
    assert [p.name for p in tmp_path.iterdir()] == ["state.json"]
    good = json.loads(path.read_text())
    entry = good["rollbacks"][0]
    bad_cases: list[tuple[object, str]] = [
        ("not json", "not valid JSON"),
        ([], "expected a foresite-rollback-state version 1"),
        ({**good, "version": 2}, "version 1"),
        ({**good, "rollbacks": {}}, "rollbacks must be a list"),
        ({**good, "rollbacks": [1]}, "must be an object"),
        ({**good, "rollbacks": [{**entry, "alert_id": ""}]}, "alert_id must be a non-empty"),
        ({**good, "rollbacks": [{**entry, "venue_id": "=bad"}]}, "not a valid identifier"),
        ({**good, "rollbacks": [{**entry, "status": "paused"}]}, "status must be"),
        ({**good, "rollbacks": [{**entry, "checks": {}}]}, "checks must be a list"),
        ({**good, "rollbacks": [{**entry, "checks": [1]}]}, "entries must be objects"),
        (
            {**good, "rollbacks": [{**entry, "checks": [{"week_start": "2026-01-05"}]}]},
            "not a known decision",
        ),
        ({**good, "rollbacks": [{**entry, "trigger_week_start": "5 Jan"}]}, "YYYY-MM-DD"),
        ({**good, "rollbacks": [{**entry, "reinstated_on": 5}]}, "reinstated_on must be a date"),
    ]
    for payload, message in bad_cases:
        path.write_text(payload if isinstance(payload, str) else json.dumps(payload))
        with pytest.raises(ValueError, match=message):
            read_rollback_state(path)
    minimal = {k: v for k, v in entry.items() if k not in ("checks", "reinstated_on")}
    path.write_text(json.dumps({**good, "rollbacks": [minimal]}))
    (loaded,) = read_rollback_state(path)
    assert loaded.checks == ()
    assert loaded.reinstated_on is None


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


def test_gate_rejects_holdout_forecasts_from_a_model_trained_on_that_week() -> None:
    s = scenario(["better"] * 8)
    first_holdout = FIRST_MONDAY
    # Trained up to the Sunday before the first hold-out week: fine.
    ok = s.challenger.with_columns(training_end=pl.lit(first_holdout - timedelta(days=1)))
    (g,) = beats_baseline(ok, s.baseline, s.actuals, require_training_end=True)
    assert g.passed
    # One row whose model was trained up to its own week's Monday: refused (boundary is >=).
    target = first_holdout + timedelta(weeks=3, days=2)
    leaky = ok.with_columns(
        training_end=pl.when(pl.col("target_day") == target)
        .then(pl.lit(target - timedelta(days=2)))
        .otherwise(pl.col("training_end"))
    )
    with pytest.raises(ValueError, match=r"1 challenger forecast\(s\) in the hold-out weeks"):
        beats_baseline(leaky, s.baseline, s.actuals)
    # The same row outside the hold-out weeks is not the gate's concern.
    (g,) = beats_baseline(leaky, s.baseline, s.actuals, holdout_weeks=3)
    assert g.passed
    leaky_baseline = s.baseline.with_columns(training_end=pl.lit(first_holdout))
    with pytest.raises(ValueError, match="baseline forecast"):
        beats_baseline(ok, leaky_baseline, s.actuals)


def test_sign_off_needs_training_end_on_every_challenger_row() -> None:
    s = scenario(["better"] * 8)
    (g,) = beats_baseline(s.challenger, s.baseline, s.actuals)  # not a sign-off run: allowed
    assert g.passed
    with pytest.raises(ValueError, match=r"sign-off needs training_end.*56 row"):
        beats_baseline(s.challenger, s.baseline, s.actuals, require_training_end=True)
    partly = s.challenger.with_columns(
        training_end=pl.when(pl.col("target_day") > FIRST_MONDAY)
        .then(pl.lit(FIRST_MONDAY - timedelta(days=1)))
        .otherwise(None)
    )
    with pytest.raises(ValueError, match=r"1 row\(s\) have none \(first: target 2026-01-05"):
        beats_baseline(partly, s.baseline, s.actuals, require_training_end=True)
    no_column = s.challenger.drop("training_end")
    (g,) = beats_baseline(no_column, s.baseline.drop("training_end"), s.actuals)
    assert g.passed
    with pytest.raises(ValueError, match="sign-off needs training_end"):
        beats_baseline(no_column, s.baseline, s.actuals, require_training_end=True)


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
