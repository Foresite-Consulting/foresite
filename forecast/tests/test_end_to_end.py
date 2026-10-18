"""End-to-end backtest: two years of rolling baseline forecasts on SYNTHETIC data.

Reports (and pins within tolerance) the baseline's WAPE by horizon and its
interval coverage, then runs the rollback and gate logic against known-good,
known-bad and degrading SYNTHETIC challengers.
"""

from __future__ import annotations

from collections import Counter
from datetime import date

import pytest

from foresite_forecast.accuracy import accuracy_report, forecasts_to_frame, score
from foresite_forecast.baseline import RULE_CLOSED, RULE_HOLIDAY, RULE_NEIGHBOURS, RULE_SWLY
from foresite_forecast.selection import beats_baseline, decide_rollback
from foresite_forecast.synthetic import synthetic_challenger
from tests.conftest import Backtest

METRIC = "net_sales_ex_gst_cents"


def test_baseline_backtest_accuracy_and_coverage(backtest: Backtest) -> None:
    frame = forecasts_to_frame(backtest.forecasts)
    scored = score(frame, backtest.dataset.actuals)
    report = accuracy_report(scored)
    (overall,) = report.overall.iter_rows(named=True)
    by_h = {r["horizon_days"]: r for r in report.by_horizon.iter_rows(named=True)}
    summary = {
        h: (round(by_h[h]["wape"], 4), round(by_h[h]["coverage"], 4)) for h in (1, 7, 14, 28)
    }
    print(
        f"baseline WAPE/coverage by horizon: {summary}; overall {overall['wape']:.4f}/"
        f"{overall['coverage']:.4f}"
    )
    # 8% day-level noise on both the target and last year's day gives roughly 9-10% WAPE.
    assert 0.07 <= overall["wape"] <= 0.12
    for h in (1, 7, 14, 28):
        assert 0.07 <= by_h[h]["wape"] <= 0.12
        assert 0.74 <= by_h[h]["coverage"] <= 0.86  # 10-90 range: about 80%
    assert 0.76 <= overall["coverage"] <= 0.84
    assert abs(overall["bias"]) < 0.02
    rules = Counter(f.rule for f in backtest.forecasts)
    assert {RULE_SWLY, RULE_HOLIDAY, RULE_NEIGHBOURS, RULE_CLOSED} <= set(rules)
    assert rules[RULE_SWLY] > 0.9 * len(backtest.forecasts)


def test_rollback_and_gate_against_known_challengers(backtest: Backtest) -> None:
    actuals = backtest.dataset.actuals
    baseline = forecasts_to_frame(backtest.forecasts)

    good = synthetic_challenger(baseline, actuals, quality="good")
    (keep,) = decide_rollback(good, baseline, actuals)
    assert keep.decision == "keep"
    (passed,) = beats_baseline(good, baseline, actuals, holdout_weeks=8)
    assert passed.passed
    assert passed.challenger_wape is not None
    assert passed.baseline_wape is not None
    assert passed.challenger_wape == pytest.approx(passed.baseline_wape / 2, rel=0.02)

    bad = synthetic_challenger(baseline, actuals, quality="bad")
    (rolled,) = decide_rollback(bad, baseline, actuals)
    assert rolled.decision == "rollback_to_baseline"
    assert rolled.alert is not None
    (failed,) = beats_baseline(bad, baseline, actuals, holdout_weeks=8)
    assert failed.status == "fail"

    # Goes bad on Monday 21 Sep 2026: weeks of 21 Sep, 28 Sep, 5 Oct and 12 Oct are worse.
    degrading = synthetic_challenger(
        baseline, actuals, quality="good", degrade_from=date(2026, 9, 21)
    )
    (d,) = decide_rollback(degrading, baseline, actuals)
    assert d.decision == "rollback_to_baseline"
    # Checked a week earlier, only three weeks were worse: no rollback yet.
    (early,) = decide_rollback(degrading, baseline, actuals, evaluation_day=date(2026, 10, 11))
    assert early.decision == "keep"
